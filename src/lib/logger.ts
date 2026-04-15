import pino from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
type LogMode = 'server' | 'cli';

export interface Logger {
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info:  (...args: unknown[]) => void;
  warn:  (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
  flush: () => void;
  child: (bindings: Record<string, unknown>) => Logger;
}

let _logger: pino.Logger = buildCliLogger('info');

function buildCliLogger(level: string): pino.Logger {
  return pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        sync: true,
      },
    },
  });
}

function buildServerLogger(logFile: string | undefined, level: string): pino.Logger {
  const target = process.env.TRUST_LOG_FILE ?? logFile;
  if (!target) {
    return pino({ level });
  }
  return pino({ level }, pino.destination(target));
}

function wrapPino(getInstance: () => pino.Logger): Logger {
  function makeLogFn(method: string) {
    return (...args: unknown[]) => (getInstance() as any)[method](...args);
  }
  return {
    trace: makeLogFn('trace'),
    debug: makeLogFn('debug'),
    info:  makeLogFn('info'),
    warn:  makeLogFn('warn'),
    error: makeLogFn('error'),
    fatal: makeLogFn('fatal'),
    flush: () => getInstance().flush(),
    child(bindings: Record<string, unknown>): Logger {
      const childInstance = getInstance().child(bindings);
      return wrapPino(() => childInstance);
    },
  };
}

/**
 * Switch the logger to the given mode.
 * Call once at startup before any log calls are made.
 *
 *  - 'server'  → structured JSON to stdout (works with Docker / Coolify / journald).
 *               Set TRUST_LOG_FILE=/var/log/trust/app.log to write to a file instead.
 *  - 'cli'     → pretty-printed to stdout (default when no call is made)
 *
 * Log level: TRUST_LOG_LEVEL env (default: 'info').
 * Coolify: set TRUST_LOG_LEVEL via the service environment variables UI.
 */
export function initLogger(mode: LogMode, options?: { logFile?: string; level?: string }): void {
  const level = process.env.TRUST_LOG_LEVEL ?? options?.level ?? 'info';
  _logger = mode === 'server'
    ? buildServerLogger(options?.logFile, level)
    : buildCliLogger(level);
}

/**
 * Application logger.
 * Delegates to the current internal pino instance so calling initLogger() after
 * import is reflected everywhere — including in child loggers.
 */
export const logger: Logger = wrapPino(() => _logger);

/** Raw pino instance — pass to Fastify's `loggerInstance` option. */
export function getPinoInstance(): pino.Logger {
  return _logger;
}

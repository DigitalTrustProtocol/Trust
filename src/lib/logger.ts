import pino from 'pino';

type LogMode = 'server' | 'cli';

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
  // Default: structured JSON on stdout (Docker/Coolify captures it automatically)
  // TRUST_LOG_FILE=<path>  → JSON appended to that file (bare-metal VPS with logrotate)
  const target = process.env.TRUST_LOG_FILE ?? logFile;
  if (!target) {
    return pino({ level });
  }
  return pino({ level }, pino.destination(target));
}

/**
 * Switch the logger to the given mode.
 * Call once at startup before any log calls are made.
 *
 *  - 'server'  → structured JSON to stdout (default, works with Docker/Coolify/journald)
 *               Set TRUST_LOG_FILE=/var/log/trust/app.log to write to a file instead.
 *  - 'cli'     → pretty-printed to stdout (default when no call is made)
 *
 * Log level is controlled by TRUST_LOG_LEVEL env var (default: 'info').
 */
export function initLogger(mode: LogMode, options?: { logFile?: string; level?: string }): void {
  const level = process.env.TRUST_LOG_LEVEL ?? options?.level ?? 'info';
  _logger = mode === 'server'
    ? buildServerLogger(options?.logFile, level)
    : buildCliLogger(level);
}

function makeLogFn(method: string) {
  return (...args: unknown[]) => (_logger as any)[method](...args);
}

/**
 * Application logger.
 * Always delegates to the current internal pino instance so that
 * calling initLogger() after import is reflected everywhere.
 */
export const logger = {
  trace: makeLogFn('trace'),
  debug: makeLogFn('debug'),
  info:  makeLogFn('info'),
  warn:  makeLogFn('warn'),
  error: makeLogFn('error'),
  fatal: makeLogFn('fatal'),
  child: (bindings: Record<string, unknown>) => _logger.child(bindings),
};

/** Raw pino instance — pass to Fastify's `logger` option. */
export function getPinoInstance(): pino.Logger {
  return _logger;
}

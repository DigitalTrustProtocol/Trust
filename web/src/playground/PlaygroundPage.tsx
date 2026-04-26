import { useCallback, useMemo, useState } from 'react';
import { nip19 } from 'nostr-tools';
import { WoTProvider, useWoTContext, useExtension, type ExtensionState } from '../lib/nostr-wot-sdk/react';
import { useHeaderSession } from '../components/HeaderSessionContext';
import { GraphProvider, useGraph } from './GraphContext';
import { useGraphData } from './useGraphData';
import { useNodeSelection } from './useNodeSelection';
import { PlaygroundCanvas } from './PlaygroundCanvas';
import { getWotOracleBase } from './oracle';
import { formatPubkey } from './graph/transformers';
import styles from './PlaygroundPage.module.css';

const WOT_EXTENSION_STORE =
  'https://chromewebstore.google.com/detail/nostr-wot/gfmefgdkmjpjinecjchlangpamhclhdo';

/** If context.extension is ever missing at runtime (HMR / duplicate React), avoid crashing the page. */
const EXTENSION_UI_FALLBACK: ExtensionState = {
  state: 'checking',
  isConnected: false,
  isChecking: true,
  isChecked: false,
  refresh: () => {},
};

function coerceExtensionState(x: unknown): ExtensionState {
  if (
    x &&
    typeof x === 'object' &&
    'state' in x &&
    typeof (x as { state: unknown }).state === 'string' &&
    'refresh' in x &&
    typeof (x as { refresh: unknown }).refresh === 'function'
  ) {
    return x as ExtensionState;
  }
  return EXTENSION_UI_FALLBACK;
}

function toHexPubkey(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^[0-9a-f]{64}$/i.test(t)) return t.toLowerCase();
  if (t.toLowerCase().startsWith('npub')) {
    try {
      const decoded = nip19.decode(t);
      if (decoded.type === 'npub') return decoded.data as string;
    } catch {
      return null;
    }
  }
  return null;
}

function PlaygroundChrome() {
  const wotCtx = useWoTContext();
  const wotExtUi = coerceExtensionState(wotCtx.extension);
  const { state: graphState, setFilters, resetGraph, resetFilters, isNodeExpanded } = useGraph();
  const { selectedNode, selectedProfile, clearSelection } = useNodeSelection();
  const { expandNodeFollows, isLoading, error: graphHookError, userPubkey } = useGraphData();

  const extClass =
    wotExtUi.state === 'connected'
      ? styles.extensionOk
      : wotExtUi.state === 'checking'
        ? styles.extensionWait
        : styles.extensionWarn;

  const canExpand =
    selectedNode &&
    !selectedNode.isRoot &&
    !isNodeExpanded(selectedNode.id) &&
    selectedNode.distance < 4;

  return (
    <>
      <div className={`${styles.extensionBar} ${extClass}`} role="status">
        {wotExtUi.isChecking && <span>Checking for Nostr WoT extension…</span>}
        {!wotExtUi.isChecking && wotExtUi.isConnected && (
          <span> WoT extension connected — follow lists and trust scores use your local graph.</span>
        )}
        {!wotExtUi.isChecking && !wotExtUi.isConnected && (
          <span>
            No WoT extension detected. Install the{' '}
            <a href={WOT_EXTENSION_STORE} target="_blank" rel="noopener noreferrer">
              Nostr WoT extension
            </a>{' '}
            for the same experience as{' '}
            <a href="https://nostr-wot.com" target="_blank" rel="noopener noreferrer">
              nostr-wot.com
            </a>
            , or enter a hex / npub below for oracle fallback (distance queries only).
          </span>
        )}
      </div>

      <div className={styles.toolbar}>
        <label className={styles.field}>
          <span>Search nodes</span>
          <input
            className={styles.input}
            value={graphState.filters.searchQuery}
            onChange={(e) => setFilters({ searchQuery: e.target.value })}
            placeholder="Name or pubkey fragment"
            autoComplete="off"
          />
        </label>
        <label className={styles.field}>
          <span>Min trust (0–1)</span>
          <input
            className={styles.input}
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={graphState.filters.minTrustScore}
            onChange={(e) => setFilters({ minTrustScore: Number(e.target.value) })}
          />
        </label>
        <label className={styles.field}>
          <span>Max hop distance</span>
          <input
            className={styles.input}
            type="number"
            min={1}
            max={6}
            value={graphState.filters.maxDistance}
            onChange={(e) => setFilters({ maxDistance: Number(e.target.value) })}
          />
        </label>
        <div className={styles.rowActions}>
          <button type="button" className={styles.btn} onClick={() => resetFilters()}>
            Reset filters
          </button>
          <button type="button" className={styles.btn} onClick={() => resetGraph()}>
            Reset graph
          </button>
        </div>
      </div>

      <p className={styles.hint}>
        Click a node to inspect it. Right-click a node (or use Expand below) to load follows. Oracle
        fallback uses the same public endpoint as nostr-wot when the extension has no batch result.
      </p>

      {graphHookError && (
        <p className={styles.error} role="alert">
          {graphHookError}
        </p>
      )}
      {isLoading && <p className={styles.warn}>Loading…</p>}

      <div className={styles.mainGrid}>
        <div className={styles.graphShell}>
          <PlaygroundCanvas onExpandFollows={expandNodeFollows} />
        </div>
        <aside className={styles.sidePanel} aria-label="Node details">
          <h2>Selection</h2>
          {!selectedNode && <p className={styles.muted}>Click a node in the graph.</p>}
          {selectedNode && (
            <>
              {selectedProfile?.picture && (
                <img
                  src={selectedProfile.picture}
                  alt=""
                  width={64}
                  height={64}
                  style={{ borderRadius: 8, objectFit: 'cover' }}
                />
              )}
              <p style={{ fontWeight: 600, margin: '0.5rem 0 0' }}>
                {selectedProfile?.displayName || selectedProfile?.name || formatPubkey(selectedNode.id)}
              </p>
              <pre className={styles.meta}>{selectedNode.id}</pre>
              {selectedProfile?.about && (
                <p className={styles.muted} style={{ marginTop: '0.5rem' }}>
                  {selectedProfile.about.length > 280
                    ? `${selectedProfile.about.slice(0, 280)}…`
                    : selectedProfile.about}
                </p>
              )}
              <ul className={styles.statList}>
                <li>
                  <strong>Trust score</strong>: {selectedNode.trustScore.toFixed(3)}
                </li>
                <li>
                  <strong>Hops</strong>: {selectedNode.distance}
                </li>
                <li>
                  <strong>Paths</strong>: {selectedNode.pathCount}
                </li>
              </ul>
              {selectedNode.isRoot && userPubkey && (
                <p className={styles.muted}>This is you (root). Right-click to expand your follows.</p>
              )}
              {canExpand && (
                <button
                  type="button"
                  className={styles.btnPrimary}
                  style={{ marginTop: '0.75rem', width: '100%' }}
                  onClick={() => void expandNodeFollows(selectedNode.id)}
                >
                  Expand follows
                </button>
              )}
              {selectedNode.isRoot && (
                <button
                  type="button"
                  className={styles.btnPrimary}
                  style={{ marginTop: '0.5rem', width: '100%' }}
                  onClick={() => void expandNodeFollows(selectedNode.id)}
                >
                  Expand your follows
                </button>
              )}
              <button
                type="button"
                className={styles.btn}
                style={{ marginTop: '0.5rem', width: '100%' }}
                onClick={() => clearSelection()}
              >
                Clear selection
              </button>
            </>
          )}
        </aside>
      </div>
    </>
  );
}

function PlaygroundWithProviders({
  oracleUrl,
  hexFallback,
}: {
  oracleUrl: string;
  hexFallback: string | null;
}) {
  const options = useMemo(() => {
    const base = oracleUrl.trim().replace(/\/+$/, '');
    if (!hexFallback) return { oracle: base };
    // Top-level myPubkey lets getMyPubkey() work without window.nostr.wot (oracle + NIP-07 users).
    return { oracle: base, myPubkey: hexFallback, fallback: { myPubkey: hexFallback, oracle: base } };
  }, [oracleUrl, hexFallback]);

  return (
    <WoTProvider options={options}>
      <GraphProvider>
        <PlaygroundChrome />
      </GraphProvider>
    </WoTProvider>
  );
}

type NostrWindow = { nostr?: { getPublicKey?: () => Promise<string> } };

function PlaygroundExtensionChecking() {
  return (
    <div className={styles.page}>
      <p className={styles.lead} role="status">
        Checking for the Nostr WoT browser extension…
      </p>
    </div>
  );
}

function PlaygroundExtensionGate() {
  const wotExt = useExtension();
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>WoT playground</h1>
        <p className={styles.lead}>
          The playground is available only when the{' '}
          <a href={WOT_EXTENSION_STORE} target="_blank" rel="noopener noreferrer">
            Nostr WoT extension
          </a>{' '}
          is installed and enabled for this site (<code className={styles.code}>window.nostr.wot</code>
          ).
        </p>
      </header>
      <p className={styles.hint}>
        After installing, grant the extension access to this origin if prompted, then use &quot;Check
        again&quot; or reload the page.
      </p>
      <div className={styles.rowActions}>
        <button type="button" className={styles.btnPrimary} onClick={() => wotExt.refresh()}>
          Check again
        </button>
        <a
          className={styles.btn}
          href={WOT_EXTENSION_STORE}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: 'inline-block', textDecoration: 'none', lineHeight: 'inherit' }}
        >
          Chrome Web Store
        </a>
      </div>
    </div>
  );
}

export function PlaygroundPage() {
  const wotExt = useExtension();
  const { signedOut } = useHeaderSession();
  const [oracleUrl, setOracleUrl] = useState(() => getWotOracleBase());
  const [manualKey, setManualKey] = useState('');
  const hexFallback = useMemo(() => toHexPubkey(manualKey), [manualKey]);
  const providerKey = `${oracleUrl}|${hexFallback ?? ''}`;

  const fillPubkeyFromNip07 = useCallback(async () => {
    const pk = await (window as NostrWindow).nostr?.getPublicKey?.();
    if (pk && /^[0-9a-f]{64}$/i.test(pk)) {
      setManualKey(pk.toLowerCase());
    }
  }, []);

  if (wotExt.isChecking) {
    return <PlaygroundExtensionChecking />;
  }
  if (!wotExt.isConnected || signedOut) {
    return <PlaygroundExtensionGate />;
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>WoT playground</h1>
        <p className={styles.lead}>
          Interactive follow graph powered by the vendored{' '}
          <a href="https://github.com/nostr-wot/nostr-wot-sdk" target="_blank" rel="noopener noreferrer">
            nostr-wot-sdk
          </a>{' '}
          (under <code className={styles.code}>web/src/lib/nostr-wot-sdk</code>), matching the nostr-wot
          playground: extension-first,{' '}
          <code className={styles.code}>{getWotOracleBase()}</code> as the default oracle.
        </p>
      </header>

      <div className={styles.toolbar}>
        <label className={styles.field}>
          <span>Oracle base URL</span>
          <input
            className={styles.input}
            type="url"
            value={oracleUrl}
            onChange={(e) => setOracleUrl(e.target.value.trim())}
            placeholder="https://wot-oracle.mappingbitcoin.com"
            autoComplete="off"
          />
        </label>
        <label className={styles.field}>
          <span>Your pubkey (optional, hex or npub)</span>
          <input
            className={styles.input}
            value={manualKey}
            onChange={(e) => setManualKey(e.target.value)}
            placeholder="When no WoT extension — needed for oracle / graph root"
            autoComplete="off"
          />
        </label>
        <div className={styles.rowActions} style={{ alignSelf: 'flex-end' }}>
          <button type="button" className={styles.btn} onClick={() => void fillPubkeyFromNip07()}>
            Use NIP-07 signer
          </button>
        </div>
      </div>
      {manualKey.trim() && !hexFallback && (
        <p className={styles.warn} role="alert">
          Could not parse pubkey. Use 64-char hex or npub1…
        </p>
      )}

      <PlaygroundWithProviders key={providerKey} oracleUrl={oracleUrl} hexFallback={hexFallback} />
    </div>
  );
}

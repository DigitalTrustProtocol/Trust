import { useCallback, useEffect, useMemo, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { fetchGraphExport, getApiBase, postResolve } from '../api';
import styles from './GraphPage.module.css';

type VizNode = {
  id: string;
  type?: string;
  identity?: Record<string, string>;
};

type VizLink = { source: string; target: string; value: number; context?: string };

function linkColor(v: number): string {
  if (v === 1) return '#16a34a';
  if (v === -1) return '#dc2626';
  return '#94a3b8';
}

function formatNodeSummary(n: VizNode): string {
  const lines = [n.id];
  if (n.identity) {
    const name = n.identity.display_name || n.identity.name;
    if (name) lines.unshift(name);
    const about = n.identity.about;
    if (about && about.length < 200) lines.push(about);
  }
  return lines.join('\n');
}

type PathEl = {
  node: string;
  identity?: Record<string, string>;
  from: Array<[string, string, number, number, number]>;
};

function pathToGraph(path: PathEl[] | undefined): { nodes: VizNode[]; links: VizLink[] } | null {
  if (!path || path.length === 0) return null;
  const nodeMap = new Map<string, VizNode>();
  const links: VizLink[] = [];
  const seen = new Set<string>();

  for (const el of path) {
    nodeMap.set(el.node, { id: el.node, identity: el.identity });
    for (const item of el.from) {
      const author = item[1];
      const value = item[4] as number;
      if (!nodeMap.has(author)) nodeMap.set(author, { id: author });
      const key = `${author}->${el.node}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: author, target: el.node, value });
    }
  }

  return { nodes: [...nodeMap.values()], links };
}

export function GraphPage() {
  const defaultBase = getApiBase();
  const [apiBase, setApiBase] = useState(defaultBase);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [graphData, setGraphData] = useState<{ nodes: VizNode[]; links: VizLink[] }>({ nodes: [], links: [] });

  const [hover, setHover] = useState<VizNode | null>(null);

  const [authorIn, setAuthorIn] = useState('');
  const [subjectIn, setSubjectIn] = useState('');
  const [contextIn, setContextIn] = useState('');
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolveScore, setResolveScore] = useState<Record<string, unknown> | null>(null);
  const [pathGraph, setPathGraph] = useState<{ nodes: VizNode[]; links: VizLink[] } | null>(null);

  const loadFullGraph = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await fetchGraphExport(apiBase, 10_000);
      setTruncated(data.truncated);
      setGraphData({
        nodes: data.nodes.map((n) => ({
          id: n.id,
          type: n.type,
          identity: n.identity,
        })),
        links: data.links.map((l) => ({
          source: l.source,
          target: l.target,
          value: l.value,
          context: l.context,
        })),
      });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setGraphData({ nodes: [], links: [] });
    }
  }, [apiBase]);

  useEffect(() => {
    void loadFullGraph();
  }, [loadFullGraph]);

  const onRunResolve = async () => {
    setResolveError(null);
    setResolveScore(null);
    setPathGraph(null);
    if (!authorIn.trim() || !subjectIn.trim()) {
      setResolveError('Author and subject are required.');
      return;
    }
    try {
      const score = await postResolve(apiBase, {
        author: authorIn.trim(),
        subject: subjectIn.trim(),
        context: contextIn.trim() || undefined,
        format: 'path',
        maxDepth: 4,
      });
      setResolveScore(score);
      const path = score.path as PathEl[] | undefined;
      const pg = pathToGraph(path);
      setPathGraph(pg);
    } catch (e) {
      setResolveError(e instanceof Error ? e.message : String(e));
    }
  };

  const fgFull = useMemo(
    () => ({
      nodes: graphData.nodes,
      links: graphData.links,
    }),
    [graphData],
  );

  const fgPath = useMemo(
    () =>
      pathGraph ?? {
        nodes: [],
        links: [],
      },
    [pathGraph],
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>Trust graph</h1>
        <p className={styles.lead}>
          Data comes from the Trust HTTP API (same origin as this app, or{' '}
          <code className={styles.code}>api.trust.dance</code> when configured). The Nostr relay for live events
          is <code className={styles.code}>wss://relay.trust.dance/relay</code> — this page uses REST{' '}
          <code className={styles.code}>/graph/export</code> and <code className={styles.code}>/resolve</code> for
          visualization.
        </p>
      </header>

      <section className={styles.panel} aria-label="API endpoint">
        <label className={styles.field}>
          <span>API base URL</span>
          <input
            type="url"
            className={styles.input}
            placeholder="https://api.trust.dance (empty = same origin)"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value.trim())}
          />
        </label>
        <button type="button" className={styles.btn} onClick={() => void loadFullGraph()}>
          Reload graph
        </button>
      </section>

      {loadError && (
        <div className={styles.warn} role="status">
          {loadError}
        </div>
      )}
      {truncated && !loadError && (
        <div className={styles.info} role="status">
          Graph export hit the edge limit; increase <code className={styles.code}>maxEdges</code> on the server
          query if needed.
        </div>
      )}

      <section className={styles.section} aria-label="Full trust graph">
        <h2>Network graph</h2>
        <p className={styles.hint}>Hover a node to see id and profile metadata when available.</p>
        <div className={styles.graphWrap}>
          {fgFull.nodes.length === 0 ? (
            <div className={styles.graphEmpty}>
              No graph data. Set API base to your Trust HTTP server (e.g. same host as this app or{' '}
              https://api.trust.dance) and ensure the graph is loaded.
            </div>
          ) : (
            <ForceGraph2D
              graphData={fgFull}
              nodeLabel={(n: object) => formatNodeSummary(n as VizNode)}
              nodeAutoColorBy="type"
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              linkColor={(l: object) => linkColor((l as VizLink).value)}
              linkWidth={1.2}
              onNodeHover={(n: object | null) => setHover(n ? (n as VizNode) : null)}
              cooldownTicks={120}
            />
          )}
        </div>
        {hover && (
          <aside className={styles.hoverCard} aria-live="polite">
            <strong>Node</strong>
            <pre className={styles.meta}>{formatNodeSummary(hover)}</pre>
          </aside>
        )}
      </section>

      <section className={styles.section} aria-label="Resolve path">
        <h2>Resolve path</h2>
        <p className={styles.hint}>
          Enter an author (npub or hex pubkey) and a subject id. The server runs trust resolution with{' '}
          <code className={styles.code}>format: path</code> so you can see how trust propagates.
        </p>
        <div className={styles.form}>
          <label className={styles.field}>
            <span>Author</span>
            <input
              className={styles.input}
              value={authorIn}
              onChange={(e) => setAuthorIn(e.target.value)}
              placeholder="npub1… or 64-char hex"
              autoComplete="off"
            />
          </label>
          <label className={styles.field}>
            <span>Subject</span>
            <input
              className={styles.input}
              value={subjectIn}
              onChange={(e) => setSubjectIn(e.target.value)}
              placeholder="Subject (npub, nevent, hash, …)"
              autoComplete="off"
            />
          </label>
          <label className={styles.field}>
            <span>Context (optional)</span>
            <input
              className={styles.input}
              value={contextIn}
              onChange={(e) => setContextIn(e.target.value)}
              placeholder="e.g. development"
              autoComplete="off"
            />
          </label>
          <button type="button" className={styles.btnPrimary} onClick={() => void onRunResolve()}>
            Resolve
          </button>
        </div>
        {resolveError && (
          <div className={styles.warn} role="alert">
            {resolveError}
          </div>
        )}
        {resolveScore && (
          <div className={styles.scoreCard}>
            <strong>Score</strong>
            <ul className={styles.scoreList}>
              <li>
                <code>trustValue</code>: {String(resolveScore.trustValue)}
              </li>
              <li>
                <code>degree</code>: {String(resolveScore.degree)}
              </li>
              <li>
                <code>connected</code>: {String(resolveScore.connected)}
              </li>
              <li>
                <code>trust</code> / <code>distrust</code>: {String(resolveScore.trust)} /{' '}
                {String(resolveScore.distrust)}
              </li>
            </ul>
          </div>
        )}
        {pathGraph && pathGraph.nodes.length > 0 && (
          <>
            <h3 className={styles.subh}>Path graph</h3>
            <div className={styles.graphWrapSmall}>
              <ForceGraph2D
                graphData={fgPath}
                nodeLabel={(n: object) => formatNodeSummary(n as VizNode)}
                linkDirectionalArrowLength={3}
                linkDirectionalArrowRelPos={1}
                linkColor={(l: object) => linkColor((l as VizLink).value)}
                linkWidth={2}
                cooldownTicks={100}
              />
            </div>
          </>
        )}
        {resolveScore && (!pathGraph || pathGraph.nodes.length === 0) && (
          <p className={styles.muted}>No path edges returned for this query (disconnected or neutral-only path).</p>
        )}
      </section>
    </div>
  );
}

import ForceGraph2D from 'react-force-graph-2d';
import { useCallback, useMemo } from 'react';
import { useGraph } from './GraphContext';
import { useNodeSelection } from './useNodeSelection';
import type { GraphNode, GraphEdge } from './graph/types';
import { getTrustColorHex } from './graph/colors';
import { formatPubkey } from './graph/transformers';
import styles from './PlaygroundPage.module.css';

export function PlaygroundCanvas({
  onExpandFollows,
}: {
  onExpandFollows: (pubkey: string) => void;
}) {
  const { filteredData } = useGraph();
  const { select, setHovered } = useNodeSelection();

  const graphData = useMemo(
    () => ({
      nodes: filteredData.nodes,
      links: filteredData.links,
    }),
    [filteredData],
  );

  const nodeLabel = useCallback((n: object) => {
    const node = n as GraphNode;
    const label =
      node.label && node.label !== formatPubkey(node.id) ? node.label : formatPubkey(node.id);
    return `${label}\nscore ${node.trustScore.toFixed(2)} · hop ${node.distance}`;
  }, []);

  const nodeColor = useCallback((n: object) => {
    const node = n as GraphNode;
    if (node.isRoot) return '#6366f1';
    return getTrustColorHex(node.trustScore);
  }, []);

  const linkColor = useCallback((l: object) => {
    const e = l as GraphEdge;
    const s = typeof e.strength === 'number' ? e.strength : 0.5;
    return getTrustColorHex(Math.min(1, Math.max(0, s)));
  }, []);

  const onNodeClick = useCallback(
    (n: object) => {
      select(n as GraphNode);
    },
    [select],
  );

  const onNodeRightClick = useCallback(
    (ev: MouseEvent, n: object) => {
      ev.preventDefault();
      void onExpandFollows((n as GraphNode).id);
    },
    [onExpandFollows],
  );

  if (graphData.nodes.length === 0) {
    return (
      <div className={styles.canvasEmpty}>
        When the WoT extension (or oracle fallback pubkey) is ready, your node appears here. Expand
        follows by right-clicking a node or using the side panel.
      </div>
    );
  }

  return (
    <ForceGraph2D
      graphData={graphData}
      nodeLabel={nodeLabel}
      nodeColor={nodeColor}
      linkColor={linkColor}
      linkDirectionalArrowLength={3}
      linkDirectionalArrowRelPos={1}
      linkWidth={1}
      onNodeClick={onNodeClick}
      onNodeRightClick={onNodeRightClick}
      onNodeHover={(n) => setHovered(n ? (n as GraphNode) : null)}
      cooldownTicks={100}
      backgroundColor="rgba(248, 250, 252, 1)"
    />
  );
}

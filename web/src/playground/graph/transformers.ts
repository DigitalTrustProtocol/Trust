// Data transformation utilities for graph visualization

import type {
  GraphNode,
  GraphEdge,
  GraphData,
  GraphFilters,
  GraphStats,
  NodeProfile,
} from "./types";
import { calculateTrustScore } from "./colors";

/**
 * Transform follow list data to graph nodes and edges
 */
export function transformFollowsToGraph(
  rootPubkey: string,
  follows: string[],
  profiles: Map<string, NodeProfile>,
  mutuals: Set<string> = new Set()
): GraphData {
  const nodes: GraphNode[] = [];
  const links: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const pathCounts = new Map<string, number>();

  // Count paths to each node (for distance 1, each follow is 1 path)
  for (const pubkey of follows) {
    pathCounts.set(pubkey, 1);
  }

  // Add root node
  const rootProfile = profiles.get(rootPubkey);
  nodes.push({
    id: rootPubkey,
    label: rootProfile?.displayName || rootProfile?.name || formatPubkey(rootPubkey),
    picture: rootProfile?.picture,
    distance: 0,
    pathCount: 1,
    trustScore: 1,
    isRoot: true,
    isMutual: false,
  });
  nodeIds.add(rootPubkey);

  // Add follow nodes
  for (const pubkey of follows) {
    if (nodeIds.has(pubkey)) continue;

    const profile = profiles.get(pubkey);
    const isMutual = mutuals.has(pubkey);
    const pathCount = pathCounts.get(pubkey) || 1;
    const trustScore = calculateTrustScore(1, pathCount);

    nodes.push({
      id: pubkey,
      label: profile?.displayName || profile?.name || formatPubkey(pubkey),
      picture: profile?.picture,
      distance: 1,
      pathCount,
      trustScore,
      isRoot: false,
      isMutual,
    });
    nodeIds.add(pubkey);

    // Add edge from root to follow
    links.push({
      source: rootPubkey,
      target: pubkey,
      type: isMutual ? "mutual" : "follow",
      strength: trustScore,
      bidirectional: isMutual,
    });
  }

  return { nodes, links };
}

/**
 * Merge additional follows into existing graph (for expansion)
 * Also tracks path counts for trust calculation
 */
export function expandGraph(
  existing: GraphData,
  expandedPubkey: string,
  newFollows: string[],
  profiles: Map<string, NodeProfile>,
  parentDistance: number
): GraphData {
  const nodes = [...existing.nodes];
  const links = [...existing.links];
  const existingIds = new Set(existing.nodes.map((n) => n.id));

  // Track path counts - count how many ways to reach each node
  const pathCounts = new Map<string, number>();
  existing.nodes.forEach((n) => pathCounts.set(n.id, n.pathCount || 1));

  for (const pubkey of newFollows) {
    // Update path count for existing nodes
    if (existingIds.has(pubkey)) {
      const currentCount = pathCounts.get(pubkey) || 1;
      pathCounts.set(pubkey, currentCount + 1);

      // Update the node's path count and trust score
      const nodeIndex = nodes.findIndex((n) => n.id === pubkey);
      if (nodeIndex >= 0) {
        const node = nodes[nodeIndex];
        const newPathCount = currentCount + 1;
        nodes[nodeIndex] = {
          ...node,
          pathCount: newPathCount,
          trustScore: calculateTrustScore(node.distance, newPathCount),
        };
      }
    }

    // Add edge even if node exists (shows additional path)
    const existingLink = links.find(
      (l) =>
        (getEdgeSource(l) === expandedPubkey && getEdgeTarget(l) === pubkey) ||
        (getEdgeSource(l) === pubkey && getEdgeTarget(l) === expandedPubkey)
    );

    if (!existingLink) {
      const targetNode = nodes.find((n) => n.id === pubkey);
      const trustScore = targetNode
        ? targetNode.trustScore
        : calculateTrustScore(parentDistance + 1, 1);

      links.push({
        source: expandedPubkey,
        target: pubkey,
        type: "follow",
        strength: trustScore,
        bidirectional: false,
      });
    }

    // Only add new nodes
    if (existingIds.has(pubkey)) continue;

    const profile = profiles.get(pubkey);
    const distance = parentDistance + 1;
    const pathCount = 1;
    const trustScore = calculateTrustScore(distance, pathCount);

    nodes.push({
      id: pubkey,
      label: profile?.displayName || profile?.name || formatPubkey(pubkey),
      picture: profile?.picture,
      distance,
      pathCount,
      trustScore,
      isRoot: false,
      isMutual: false,
    });
    existingIds.add(pubkey);
    pathCounts.set(pubkey, pathCount);
  }

  return { nodes, links };
}

/**
 * Get source ID from edge (handles both string and object)
 */
function getEdgeSource(edge: GraphEdge): string {
  return typeof edge.source === "string" ? edge.source : edge.source.id;
}

/**
 * Get target ID from edge (handles both string and object)
 */
function getEdgeTarget(edge: GraphEdge): string {
  return typeof edge.target === "string" ? edge.target : edge.target.id;
}

/**
 * Apply filters to graph data
 */
export function filterGraphData(
  data: GraphData,
  filters: GraphFilters
): GraphData {
  const {
    minTrustScore,
    maxDistance,
    showFollows,
    showMutes,
    showMutualsOnly,
    searchQuery,
  } = filters;

  // Filter nodes
  const filteredNodes = data.nodes.filter((node) => {
    // Always show root
    if (node.isRoot) return true;

    // Recalculate trust score based on current path count
    const trustScore = calculateTrustScore(node.distance, node.pathCount || 1);

    // Filter by trust score
    if (trustScore < minTrustScore) return false;

    // Filter by distance
    if (node.distance > maxDistance) return false;

    // Filter by mutual only
    if (showMutualsOnly && !node.isMutual) return false;

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesLabel = node.label?.toLowerCase().includes(query);
      const matchesId = node.id.toLowerCase().includes(query);
      if (!matchesLabel && !matchesId) return false;
    }

    return true;
  });

  const filteredNodeIds = new Set(filteredNodes.map((n) => n.id));

  // Filter edges
  const filteredLinks = data.links.filter((link) => {
    const sourceId = getEdgeSource(link);
    const targetId = getEdgeTarget(link);

    // Both endpoints must be in filtered nodes
    if (!filteredNodeIds.has(sourceId) || !filteredNodeIds.has(targetId)) {
      return false;
    }

    // Filter by edge type
    if (link.type === "mute" && !showMutes) return false;
    if (link.type === "follow" && !showFollows) return false;

    return true;
  });

  return { nodes: filteredNodes, links: filteredLinks };
}

/**
 * Calculate graph statistics
 */
export function calculateStats(data: GraphData): GraphStats {
  if (data.nodes.length === 0) {
    return {
      totalNodes: 0,
      totalEdges: 0,
      avgTrustScore: 0,
      maxDistance: 0,
      mutualCount: 0,
    };
  }

  const totalNodes = data.nodes.length;
  const totalEdges = data.links.length;

  // Calculate average trust score (excluding root)
  const nonRootNodes = data.nodes.filter((n) => !n.isRoot);
  const avgTrustScore =
    nonRootNodes.length > 0
      ? nonRootNodes.reduce((sum, n) => {
          const score = calculateTrustScore(n.distance, n.pathCount || 1);
          return sum + score;
        }, 0) / nonRootNodes.length
      : 0;

  // Find max distance
  const maxDistance = Math.max(...data.nodes.map((n) => n.distance), 0);

  // Count mutuals
  const mutualCount = data.nodes.filter((n) => n.isMutual).length;

  return {
    totalNodes,
    totalEdges,
    avgTrustScore,
    maxDistance,
    mutualCount,
  };
}

/**
 * Convert hex pubkey to npub format (bech32)
 */
export function hexToNpub(hex: string): string {
  // If already npub, return as-is
  if (hex.startsWith("npub")) return hex;

  try {
    const ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

    // Convert hex to bytes
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.slice(i, i + 2), 16));
    }

    // Convert bytes to 5-bit groups
    let acc = 0;
    let bits = 0;
    const values: number[] = [];

    for (const byte of bytes) {
      acc = (acc << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        values.push((acc >> bits) & 0x1f);
      }
    }
    if (bits > 0) {
      values.push((acc << (5 - bits)) & 0x1f);
    }

    // Calculate checksum (simplified polymod for npub)
    const hrp = "npub";
    const hrpExpand = [...hrp].map((c) => c.charCodeAt(0) >> 5)
      .concat([0])
      .concat([...hrp].map((c) => c.charCodeAt(0) & 31));

    let chk = 1;
    for (const v of hrpExpand.concat(values).concat([0, 0, 0, 0, 0, 0])) {
      const b = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) {
        if ((b >> i) & 1) {
          chk ^= [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3][i];
        }
      }
    }
    chk ^= 1;

    const checksum: number[] = [];
    for (let i = 0; i < 6; i++) {
      checksum.push((chk >> (5 * (5 - i))) & 31);
    }

    // Build npub string
    const data = values.concat(checksum).map((v) => ALPHABET[v]).join("");
    return `npub1${data}`;
  } catch {
    return hex;
  }
}

/**
 * Format pubkey for display (shows truncated npub)
 */
export function formatPubkey(pubkey: string): string {
  // Convert hex to npub if needed
  const npub = pubkey.startsWith("npub") ? pubkey : hexToNpub(pubkey);

  // Show truncated npub: npub1abc...xyz
  if (npub.length <= 16) return npub;
  return `${npub.slice(0, 10)}...${npub.slice(-6)}`;
}

/**
 * Sort nodes by various criteria
 */
export function sortNodes(
  nodes: GraphNode[],
  sortBy: "trust" | "distance" | "name" | "recent"
): GraphNode[] {
  const sorted = [...nodes];

  switch (sortBy) {
    case "trust":
      return sorted.sort((a, b) => {
        const scoreA = calculateTrustScore(a.distance, a.pathCount || 1);
        const scoreB = calculateTrustScore(b.distance, b.pathCount || 1);
        return scoreB - scoreA;
      });
    case "distance":
      return sorted.sort((a, b) => a.distance - b.distance);
    case "name":
      return sorted.sort((a, b) =>
        (a.label || a.id).localeCompare(b.label || b.id)
      );
    case "recent":
    default:
      return sorted;
  }
}

/**
 * Find nodes by search query
 */
export function searchNodes(nodes: GraphNode[], query: string): GraphNode[] {
  if (!query) return nodes;

  const lowerQuery = query.toLowerCase();
  return nodes.filter(
    (node) =>
      node.label?.toLowerCase().includes(lowerQuery) ||
      node.id.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Get node by pubkey
 */
export function getNodeByPubkey(
  nodes: GraphNode[],
  pubkey: string
): GraphNode | undefined {
  return nodes.find((n) => n.id === pubkey);
}

/**
 * Get neighbors of a node
 */
export function getNodeNeighbors(data: GraphData, nodeId: string): GraphNode[] {
  const neighborIds = new Set<string>();

  for (const link of data.links) {
    const sourceId = getEdgeSource(link);
    const targetId = getEdgeTarget(link);

    if (sourceId === nodeId) neighborIds.add(targetId);
    if (targetId === nodeId) neighborIds.add(sourceId);
  }

  return data.nodes.filter((n) => neighborIds.has(n.id));
}

/**
 * Calculate path count between root and target node
 * Uses BFS to find all paths
 */
export function calculatePathCount(
  data: GraphData,
  targetId: string
): number {
  const rootNode = data.nodes.find((n) => n.isRoot);
  if (!rootNode || rootNode.id === targetId) return 1;

  // Build adjacency list
  const adjacency = new Map<string, Set<string>>();
  for (const link of data.links) {
    const sourceId = getEdgeSource(link);
    const targetId = getEdgeTarget(link);

    if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
    if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());

    adjacency.get(sourceId)!.add(targetId);
    if (link.bidirectional) {
      adjacency.get(targetId)!.add(sourceId);
    }
  }

  // Count paths using dynamic programming
  const pathCounts = new Map<string, number>();
  pathCounts.set(rootNode.id, 1);

  const visited = new Set<string>();
  const queue = [rootNode.id];
  visited.add(rootNode.id);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentPaths = pathCounts.get(current) || 0;
    const neighbors = adjacency.get(current) || new Set();

    for (const neighbor of neighbors) {
      const existingPaths = pathCounts.get(neighbor) || 0;
      pathCounts.set(neighbor, existingPaths + currentPaths);

      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return pathCounts.get(targetId) || 1;
}

/**
 * Convert npub to hex if needed
 */
export function npubToHex(npubOrHex: string): string {
  if (!npubOrHex.startsWith("npub")) return npubOrHex;

  try {
    const ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    const data = npubOrHex.toLowerCase().slice(5); // skip "npub1"
    const values: number[] = [];

    for (const char of data) {
      const idx = ALPHABET.indexOf(char);
      if (idx === -1) return npubOrHex;
      values.push(idx);
    }

    let acc = 0;
    let bits = 0;
    const bytes: number[] = [];

    for (const value of values.slice(0, -6)) {
      acc = (acc << 5) | value;
      bits += 5;
      while (bits >= 8) {
        bits -= 8;
        bytes.push((acc >> bits) & 0xff);
      }
    }

    return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return npubOrHex;
  }
}

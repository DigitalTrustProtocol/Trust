import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGraphOut, fetchWhoami, getApiBase } from "../api";
import { useGraph } from "./GraphContext";
import { useWoTContext } from "../lib/nostr-wot-sdk/react";
import type { GraphData, GraphNode, GraphEdge, NodeProfile } from "./graph/types";
import { formatPubkey } from "./graph/transformers";
import { getCachedProfiles, cacheProfiles, getPubkeysToFetch } from "./cache/profileCache";

// Relays for profile fetching only
const PROFILE_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
];

function trustValueToScore(value: 1 | 0 | -1): number {
  if (value === 1) return 1;
  if (value === 0) return 0.3;
  return 0.05;
}

/**
 * Hook to fetch and manage graph data from Trust graph API.
 */
export function useGraphData(rootOverridePubkey?: string | null) {
  const {
    setData,
    mergeData,
    setRoot,
    setLoading,
    setError,
    addProfiles,
    expandNode,
    collapseNode,
    state,
  } = useGraph();

  const { wot, isReady } = useWoTContext();
  const apiBase = getApiBase();

  // Track user pubkey
  const [userPubkey, setUserPubkey] = useState<string | null>(null);

  // Use refs to avoid stale closures
  const stateRef = useRef(state);
  stateRef.current = state;

  const profileCacheRef = useRef<Map<string, NodeProfile>>(new Map());
  const expandingNodesRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);
  useEffect(() => {
    const getPubkey = async () => {
      if (!isReady) return;
      try {
        if (rootOverridePubkey) {
          setUserPubkey(rootOverridePubkey);
          return;
        }
        if (wot) {
          const pubkey = await wot.getMyPubkey();
          if (pubkey) {
            setUserPubkey(pubkey);
            return;
          }
        }
        const whoami = await fetchWhoami(apiBase);
        if (whoami.publicKey) setUserPubkey(whoami.publicKey.toLowerCase());
      } catch (err) {
        console.error("[useGraphData] Failed to get pubkey:", err);
      }
    };
    void getPubkey();
  }, [wot, isReady, apiBase, rootOverridePubkey]);

  /**
   * Fetch profiles for multiple pubkeys (optional, non-blocking)
   * Uses localStorage cache first
   */
  const fetchProfiles = useCallback(
    async (pubkeys: string[]): Promise<Map<string, NodeProfile>> => {
      // First, get all cached profiles (localStorage + memory ref)
      const cachedFromStorage = getCachedProfiles(pubkeys);
      const profiles = new Map<string, NodeProfile>(cachedFromStorage);

      // Also check memory cache for any additional
      pubkeys.forEach((pk) => {
        if (!profiles.has(pk)) {
          const cached = profileCacheRef.current.get(pk);
          if (cached) profiles.set(pk, cached);
        }
      });

      // Filter to pubkeys that need fetching
      const toFetch = getPubkeysToFetch(pubkeys.filter((pk) => !profiles.has(pk)));
      if (toFetch.length === 0) return profiles;

      return new Promise((resolve) => {
        let resolved = false;
        const newProfiles: NodeProfile[] = [];

        const timeoutId = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            // Cache new profiles to localStorage
            if (newProfiles.length > 0) {
              cacheProfiles(newProfiles);
            }
            resolve(profiles);
          }
        }, 3000);

        const ws = new WebSocket(PROFILE_RELAYS[0]);

        ws.onopen = () => {
          const batch = toFetch.slice(0, 100);
          ws.send(
            JSON.stringify([
              "REQ",
              `p-${Date.now()}`,
              { kinds: [0], authors: batch, limit: batch.length },
            ])
          );
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data[0] === "EVENT" && data[2]?.kind === 0) {
              const pubkey = data[2].pubkey;
              const content = JSON.parse(data[2].content);
              const profile: NodeProfile = {
                pubkey,
                name: content.name,
                displayName: content.display_name,
                picture: content.picture,
                about: content.about,
                nip05: content.nip05,
              };
              profiles.set(pubkey, profile);
              profileCacheRef.current.set(pubkey, profile);
              newProfiles.push(profile);
            } else if (data[0] === "EOSE") {
              ws.close();
              if (!resolved) {
                clearTimeout(timeoutId);
                resolved = true;
                // Cache new profiles to localStorage
                if (newProfiles.length > 0) {
                  cacheProfiles(newProfiles);
                }
                resolve(profiles);
              }
            }
          } catch {
            // Ignore
          }
        };

        ws.onerror = () => {
          if (!resolved) {
            clearTimeout(timeoutId);
            resolved = true;
            if (newProfiles.length > 0) {
              cacheProfiles(newProfiles);
            }
            resolve(profiles);
          }
        };

        ws.onclose = () => {
          if (!resolved) {
            clearTimeout(timeoutId);
            resolved = true;
            if (newProfiles.length > 0) {
              cacheProfiles(newProfiles);
            }
            resolve(profiles);
          }
        };
      });
    },
    []
  );

  /**
   * Build initial graph with only the root node.
   */
  const buildInitialGraph = useCallback(async () => {
    if (!userPubkey || initializedRef.current) return;

    initializedRef.current = true;
    setLoading(true);
    setError(null);

    try {
      setRoot(userPubkey);

      const graphData: GraphData = {
        nodes: [
          {
            id: userPubkey,
            label: formatPubkey(userPubkey),
            distance: 0,
            pathCount: 1,
            trustScore: 1,
            isRoot: true,
            isMutual: false,
          },
        ],
        links: [],
      };

      setData(graphData);

      // Fetch profile in background
      fetchProfiles([userPubkey]).then((profiles) => {
        if (profiles.size > 0) {
          addProfiles(profiles);
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load graph");
    } finally {
      setLoading(false);
    }
  }, [
    userPubkey,
    fetchProfiles,
    setData,
    setRoot,
    setLoading,
    setError,
    addProfiles,
  ]);

  /**
   * Expand a node by loading `GET /v1/out?author=<pubkey>`.
   */
  const expandNodeFollows = useCallback(
    async (pubkey: string) => {
      if (expandingNodesRef.current.has(pubkey)) {
        return;
      }

      const currentState = stateRef.current;
      if (currentState.expandedNodes.has(pubkey)) {
        return;
      }

      const node = currentState.data.nodes.find((n) => n.id === pubkey);
      const parentDistance = node?.distance ?? 0;

      if (parentDistance >= 4) {
        return;
      }

      expandingNodesRef.current.add(pubkey);
      expandNode(pubkey);
      setLoading(true);

      try {
        const out = await fetchGraphOut(apiBase, { author: pubkey });
        const connections = out.connections;
        if (connections.length === 0) return;

        const latestState = stateRef.current;
        const existingIds = new Set(latestState.data.nodes.map((n) => n.id));

        const newNodes: GraphNode[] = [];
        const newLinks: GraphEdge[] = [];

        // Get the parent node's current position from the live graph data
        // (react-force-graph mutates node objects with x/y/z during simulation)
        const parentNode = latestState.data.nodes.find((n) => n.id === pubkey);
        const parentX = parentNode?.x ?? 0;
        const parentY = parentNode?.y ?? 0;
        const parentZ = parentNode?.z ?? 0;

        const profilePubkeys: string[] = [];
        const totalNew = connections.length;
        let newNodeIndex = 0;

        for (const connection of connections) {
          const targetId = connection.subject;
          const subjectType = connection.subjectType;
          const pathCount = 1;
          const trustScore = trustValueToScore(connection.edge.value);
          const correctDistance = parentDistance + 1;
          const isPubkey = subjectType === "p";
          const linkType: GraphEdge["type"] =
            connection.edge.value < 0 ? "mute" : "follow";

          // Only add links to NEW nodes — skip edges to already-existing nodes
          // to avoid cross-cluster "ray" lines flying across the screen
          if (!existingIds.has(targetId)) {
            newLinks.push({
              source: pubkey,
              target: targetId,
              type: linkType,
              strength: trustScore,
              bidirectional: false,
            });
          }

          if (!existingIds.has(targetId)) {
            const cachedProfile = isPubkey ? profileCacheRef.current.get(targetId) : undefined;

            // Seed initial position scattered around the parent node
            // Use random angle + varying radius so nodes don't all appear at once in a visible ring
            const angle = Math.random() * 2 * Math.PI;
            // Scale radius with node count so sparse graphs stay tight, dense ones spread out
            const radius = Math.max(40, Math.sqrt(totalNew) * 4) * (0.6 + Math.random() * 0.8);
            const x = parentX + radius * Math.cos(angle);
            const y = parentY + radius * Math.sin(angle);
            // For 3D: small random z offset
            const z = parentZ + (Math.random() - 0.5) * radius * 0.4;
            newNodeIndex++;

            newNodes.push({
              id: targetId,
              label:
                cachedProfile?.displayName ||
                cachedProfile?.name ||
                (isPubkey ? formatPubkey(targetId) : `${subjectType}:${targetId.slice(0, 12)}...`),
              picture: cachedProfile?.picture,
              distance: correctDistance,
              pathCount,
              trustScore,
              isRoot: false,
              isMutual: false,
              expandedFrom: pubkey, // which gateway node revealed this node
              x,
              y,
              z,
            });
            if (isPubkey) profilePubkeys.push(targetId);
          }
        }

        // Cap at 150 nodes per expansion for performance, but use a STRATIFIED
        // sample so the visual represents the real WoT distribution — not just
        // the top green nodes. We split into 3 trust bands and sample evenly.
        const MAX_NEW_NODES_PER_EXPANSION = 250;
        let cappedNodes = newNodes;
        if (newNodes.length > MAX_NEW_NODES_PER_EXPANSION) {
          const sorted = [...newNodes].sort((a, b) => b.trustScore - a.trustScore);

          // Bands: high ≥0.7, medium 0.3–0.7, low <0.3
          const high   = sorted.filter(n => n.trustScore >= 0.7);
          const medium = sorted.filter(n => n.trustScore >= 0.3 && n.trustScore < 0.7);
          const low    = sorted.filter(n => n.trustScore < 0.3);

          // Allocate slots proportionally to each band (min 1 if band non-empty)
          const total = MAX_NEW_NODES_PER_EXPANSION;
          const highCount   = Math.round(total * 0.4);  // 60 — still show best
          const mediumCount = Math.round(total * 0.35); // ~52 — neutral
          const lowCount    = total - highCount - mediumCount; // ~38 — untrusted

          // Take top N from high, random sample from medium/low for real preview
          const sample = (arr: typeof newNodes, n: number) => {
            if (arr.length <= n) return arr;
            // Shuffle and take n — gives a representative sample
            const shuffled = [...arr].sort(() => Math.random() - 0.5);
            return shuffled.slice(0, n);
          };

          cappedNodes = [
            ...high.slice(0, highCount),
            ...sample(medium, mediumCount),
            ...sample(low, lowCount),
          ];
        }

        // Only keep links whose target is in the capped set or already exists
        const cappedNodeIds = new Set(cappedNodes.map(n => n.id));
        const cappedLinks = newLinks.filter(l => {
          const targetId = typeof l.target === 'string' ? l.target : (l.target as GraphNode).id;
          return existingIds.has(targetId) || cappedNodeIds.has(targetId);
        });

        // Collect distance corrections for existing nodes found in this expansion.
        const existingFollows = connections
          .map((c) => c.subject)
          .filter((id) => existingIds.has(id) && id !== pubkey);
        const distanceUpdates: GraphNode[] = [];

        if (existingFollows.length > 0) {
          for (const id of existingFollows) {
            const existingNode = latestState.data.nodes.find((n) => n.id === id);
            if (!existingNode) continue;
            if (parentDistance + 1 < existingNode.distance) {
              distanceUpdates.push({
                ...existingNode,
                distance: parentDistance + 1,
              });
            }
          }
        }

        // Single mergeData call — batching caused 10 re-renders + 10 simulation
        // reheats per expansion which was the source of lag. forceRadial handles
        // the visual placement of nodes in their orbit rings regardless.
        if (cappedNodes.length > 0 || cappedLinks.length > 0 || distanceUpdates.length > 0) {
          mergeData({ nodes: [...cappedNodes, ...distanceUpdates], links: cappedLinks });
        }

        if (profilePubkeys.length > 0) {
          fetchProfiles(profilePubkeys).then((profiles) => {
            if (profiles.size > 0) {
              addProfiles(profiles);
            }
          });
        }
      } catch (err) {
        console.error("Failed to expand node:", err);
        // Un-mark as expanded on failure so the Expand button reappears
        collapseNode(pubkey);
      } finally {
        expandingNodesRef.current.delete(pubkey);
        setLoading(false);
      }
    },
    [apiBase, expandNode, collapseNode, fetchProfiles, addProfiles, mergeData, setLoading]
  );

  // Reset refs when user changes or graph is cleared
  useEffect(() => {
    initializedRef.current = false;
    expandingNodesRef.current.clear();
  }, [userPubkey]);

  // Also reset initialized flag when graph data is emptied (manual reset)
  useEffect(() => {
    if (state.data.nodes.length === 0) {
      initializedRef.current = false;
      expandingNodesRef.current.clear();
    }
  }, [state.data.nodes.length]);

  // Build initial graph when ready
  useEffect(() => {
    if (isReady && userPubkey && state.data.nodes.length === 0) {
      buildInitialGraph();
    }
  }, [isReady, userPubkey, state.data.nodes.length, buildInitialGraph]);

  const readyForGraphApi = !!userPubkey;

  return {
    buildInitialGraph,
    expandNodeFollows,
    collapseNodeFollows: collapseNode,
    fetchProfiles,
    isLoading: state.isLoading,
    error: state.error,
    isReady: isReady && readyForGraphApi,
    userPubkey,
  };
}

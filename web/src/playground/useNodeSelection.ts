import { useCallback, useMemo } from "react";
import { useGraph } from "./GraphContext";
import type { GraphNode } from "./graph/types";
import { getNodeNeighbors } from "./graph/transformers";

/**
 * Hook for managing node selection and related operations
 */
export function useNodeSelection() {
  const {
    state,
    filteredData,
    selectNode,
    hoverNode,
    getProfile,
  } = useGraph();

  const { selectedNode, hoveredNode } = state;

  /**
   * Select a node
   */
  const select = useCallback(
    (node: GraphNode | null) => {
      selectNode(node);
    },
    [selectNode]
  );

  /**
   * Clear selection
   */
  const clearSelection = useCallback(() => {
    selectNode(null);
  }, [selectNode]);

  /**
   * Set hovered node
   */
  const setHovered = useCallback(
    (node: GraphNode | null) => {
      hoverNode(node);
    },
    [hoverNode]
  );

  /**
   * Find node by pubkey
   */
  const findNode = useCallback(
    (pubkey: string): GraphNode | undefined => {
      return filteredData.nodes.find((n) => n.id === pubkey);
    },
    [filteredData.nodes]
  );

  /**
   * Get neighbors of selected node
   */
  const selectedNeighbors = useMemo(() => {
    if (!selectedNode) return [];
    return getNodeNeighbors(filteredData, selectedNode.id);
  }, [selectedNode, filteredData]);

  /**
   * Get profile for selected node
   */
  const selectedProfile = useMemo(() => {
    if (!selectedNode) return undefined;
    return getProfile(selectedNode.id);
  }, [selectedNode, getProfile]);

  /**
   * Check if a node is selected
   */
  const isSelected = useCallback(
    (nodeId: string) => selectedNode?.id === nodeId,
    [selectedNode]
  );

  /**
   * Check if a node is hovered
   */
  const isHovered = useCallback(
    (nodeId: string) => hoveredNode?.id === nodeId,
    [hoveredNode]
  );

  /**
   * Check if a node is highlighted (selected or neighbor of selected)
   */
  const isHighlighted = useCallback(
    (nodeId: string) => {
      if (!selectedNode) return false;
      if (selectedNode.id === nodeId) return true;
      return selectedNeighbors.some((n) => n.id === nodeId);
    },
    [selectedNode, selectedNeighbors]
  );

  /**
   * Get the active node (hovered takes priority over selected)
   */
  const activeNode = hoveredNode || selectedNode;

  /**
   * Get profile for active node
   */
  const activeProfile = useMemo(() => {
    if (!activeNode) return undefined;
    return getProfile(activeNode.id);
  }, [activeNode, getProfile]);

  return {
    selectedNode,
    hoveredNode,
    activeNode,
    selectedNeighbors,
    selectedProfile,
    activeProfile,
    select,
    clearSelection,
    setHovered,
    findNode,
    isSelected,
    isHovered,
    isHighlighted,
  };
}

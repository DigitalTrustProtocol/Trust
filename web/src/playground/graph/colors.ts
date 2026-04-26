// Trust-based color calculations for graph visualization
// Uses the extension formula: score = distanceWeight × (1 + pathBonus)

import {
  type WoTScoringConfig,
  DEFAULT_SCORING_CONFIG,
} from "../cache/profileCache";

// Re-export types and defaults
export type { WoTScoringConfig };
export { DEFAULT_SCORING_CONFIG };

// Re-export for backward compatibility
export const DISTANCE_WEIGHTS = DEFAULT_SCORING_CONFIG.distanceWeights;
export const PATH_BONUS = DEFAULT_SCORING_CONFIG.pathBonus;
export const MAX_PATH_BONUS = DEFAULT_SCORING_CONFIG.maxPathBonus;

// Color stops for the trust gradient (green to red)
export const TRUST_GRADIENT = {
  high: { r: 34, g: 197, b: 94 }, // #22c55e - green (trusted)
  mid: { r: 234, g: 179, b: 8 }, // #eab308 - yellow (neutral)
  low: { r: 239, g: 68, b: 68 }, // #ef4444 - red (untrusted)
};

// Trust thresholds
export const TRUST_THRESHOLDS = {
  high: 0.7,
  medium: 0.3,
};

/**
 * Get distance weight based on hop count
 */
export function getDistanceWeight(
  distance: number,
  config?: WoTScoringConfig
): number {
  const weights = config?.distanceWeights ?? DISTANCE_WEIGHTS;

  if (distance <= 0) return weights[0] ?? 1.0;
  // Find the highest defined weight key
  const maxKey = Math.max(...Object.keys(weights).map(Number));
  if (distance >= maxKey) return weights[maxKey] ?? 0.1;
  return weights[distance] ?? 0.1;
}

/**
 * Get path bonus based on number of paths
 * Uses SDK formula: (pathCount - 1) * pathBonus, capped at maxPathBonus
 */
export function getPathBonus(
  pathCount: number,
  config?: WoTScoringConfig
): number {
  if (pathCount <= 1) return 0;

  const bonusPerPath = config?.pathBonus ?? PATH_BONUS;
  const maxBonus = config?.maxPathBonus ?? MAX_PATH_BONUS;

  const totalBonus = (pathCount - 1) * bonusPerPath;
  return Math.min(totalBonus, maxBonus);
}

/**
 * Calculate trust score using SDK formula
 * score = distanceWeight × (1 + pathBonus)
 *
 * @param distance - Number of hops from root
 * @param pathCount - Number of paths to the target
 * @param config - Optional scoring config from SDK getScoringConfig()
 */
export function calculateTrustScore(
  distance: number,
  pathCount: number = 1,
  config?: WoTScoringConfig
): number {
  if (distance === 0) return 1.0; // Root is always fully trusted

  const distanceWeight = getDistanceWeight(distance, config);
  const pathBonus = getPathBonus(pathCount, config);
  const score = distanceWeight * (1 + pathBonus);

  return Math.max(0, Math.min(1, score));
}

/**
 * Interpolate between two colors
 */
function lerpColor(
  c1: { r: number; g: number; b: number },
  c2: { r: number; g: number; b: number },
  t: number
): string {
  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const b = Math.round(c1.b + (c2.b - c1.b) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Get color based on trust score (0-1) - smooth gradient from red to green
 */
export function getTrustColor(score: number): string {
  if (score >= TRUST_THRESHOLDS.high) {
    // High trust: green
    return lerpColor(TRUST_GRADIENT.mid, TRUST_GRADIENT.high, (score - TRUST_THRESHOLDS.high) / (1 - TRUST_THRESHOLDS.high));
  }
  if (score >= TRUST_THRESHOLDS.medium) {
    // Medium trust: yellow to green gradient
    return lerpColor(TRUST_GRADIENT.mid, TRUST_GRADIENT.high, (score - TRUST_THRESHOLDS.medium) / (TRUST_THRESHOLDS.high - TRUST_THRESHOLDS.medium));
  }
  // Low trust: red to yellow gradient
  return lerpColor(TRUST_GRADIENT.low, TRUST_GRADIENT.mid, score / TRUST_THRESHOLDS.medium);
}

/**
 * Get hex color for trust score
 */
export function getTrustColorHex(score: number): string {
  if (score >= TRUST_THRESHOLDS.high) {
    const t = (score - TRUST_THRESHOLDS.high) / (1 - TRUST_THRESHOLDS.high);
    return interpolateHex("#eab308", "#22c55e", t);
  }
  if (score >= TRUST_THRESHOLDS.medium) {
    const t = (score - TRUST_THRESHOLDS.medium) / (TRUST_THRESHOLDS.high - TRUST_THRESHOLDS.medium);
    return interpolateHex("#ef4444", "#eab308", t);
  }
  const t = score / TRUST_THRESHOLDS.medium;
  return interpolateHex("#dc2626", "#ef4444", t);
}

/**
 * Interpolate between two hex colors
 */
function interpolateHex(hex1: string, hex2: string, t: number): string {
  const r1 = parseInt(hex1.slice(1, 3), 16);
  const g1 = parseInt(hex1.slice(3, 5), 16);
  const b1 = parseInt(hex1.slice(5, 7), 16);

  const r2 = parseInt(hex2.slice(1, 3), 16);
  const g2 = parseInt(hex2.slice(3, 5), 16);
  const b2 = parseInt(hex2.slice(5, 7), 16);

  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);

  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/**
 * Get node color based on trust score calculated from distance and paths
 */
export function getNodeColor(
  distance: number,
  pathCount: number = 1,
  isRoot: boolean = false
): string {
  if (isRoot) return "#6366f1"; // Primary color for root

  const trustScore = calculateTrustScore(distance, pathCount);
  return getTrustColorHex(trustScore);
}

/**
 * Get edge color based on relationship type and trust
 */
export function getEdgeColor(
  type: "follow" | "mutual" | "mute",
  trustScore?: number
): string {
  switch (type) {
    case "mutual":
      return "#22c55e"; // Green for mutual follows
    case "mute":
      return "#ef4444"; // Red for mutes
    case "follow":
    default:
      if (trustScore !== undefined) {
        return getTrustColorHex(trustScore);
      }
      return "#6b7280"; // Gray default
  }
}

/**
 * Get edge opacity based on trust strength
 */
export function getEdgeOpacity(strength: number): number {
  return Math.max(0.3, Math.min(0.9, 0.3 + strength * 0.6));
}

/**
 * Get CSS class for trust level
 */
export function getTrustClass(score: number): string {
  if (score >= TRUST_THRESHOLDS.high) {
    return "text-trust-green bg-trust-green/10";
  }
  if (score >= TRUST_THRESHOLDS.medium) {
    return "text-trust-yellow bg-trust-yellow/10";
  }
  return "text-trust-red bg-trust-red/10";
}

/**
 * Get trust level label
 */
export function getTrustLabel(score: number): string {
  if (score >= TRUST_THRESHOLDS.high) return "Trusted";
  if (score >= TRUST_THRESHOLDS.medium) return "Neutral";
  return "Untrusted";
}

/**
 * Get color for legend display based on distance
 */
export function getDistanceLegendColor(distance: number): string {
  const score = calculateTrustScore(distance, 1);
  return getTrustColorHex(score);
}

#!/usr/bin/env npx tsx
/**
 * Benchmark: Graph load from file via Graph.loadFromFile
 *
 * Loads the graph from graph-cache.bin (created by bench-load-full-graph).
 * Uses trust/ config dir.
 *
 * Reports: load time, node count, edge count, throughput, memory footprint
 *
 * Usage:
 *   # First run bench-load-full-graph to create the cache file
 *   npm run bench:load-full-graph
 *
 *   # Then run this benchmark
 *   npm run bench:load-from-file
 */

import { existsSync } from 'node:fs';
import { Graph } from '../src/lib/trust/graph/Graph.js';
import { PATHS } from '../src/config.js';

async function main() {
  console.log('📊 Graph Load from File Benchmark\n');
  console.log(`Config dir: ${PATHS.configDir}`);
  console.log(`Cache path: ${PATHS.graphCache}\n`);

  if (!existsSync(PATHS.graphCache)) {
    console.error('❌ Graph cache not found. Run: npm run bench:load-full-graph first');
    process.exit(1);
  }

  console.log('Loading graph via Graph.loadFromFile()...\n');

  const memBefore = process.memoryUsage();
  const start = performance.now();
  const graph = await Graph.loadFromFile();
  const elapsed = performance.now() - start;
  const memAfter = process.memoryUsage();

  if (!graph) {
    console.error('❌ Failed to load graph from file');
    process.exit(1);
  }

  const nodeCount = graph.nodes.size;
  const edgeCount = graph.edges.size;

  const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);
  const heapDelta = memAfter.heapUsed - memBefore.heapUsed;
  const rssDelta = memAfter.rss - memBefore.rss;

  console.log('─'.repeat(50));
  console.log('RESULTS');
  console.log('─'.repeat(50));
  console.log(`Load time:     ${(elapsed / 1000).toFixed(3)}s`);
  console.log(`Nodes:         ${nodeCount.toLocaleString()}`);
  console.log(`Edges:         ${edgeCount.toLocaleString()}`);
  if (elapsed > 0) {
    console.log(`Nodes/sec:     ${(nodeCount / (elapsed / 1000)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log(`Edges/sec:     ${(edgeCount / (elapsed / 1000)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  }
  console.log(`Memory (heap): ${formatMB(memAfter.heapUsed)} MB (Δ +${formatMB(heapDelta)} MB)`);
  console.log(`Memory (rss):  ${formatMB(memAfter.rss)} MB (Δ +${formatMB(rssDelta)} MB)`);
  console.log('─'.repeat(50));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

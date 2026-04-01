#!/usr/bin/env npx tsx

/**
 * Test script for msgpackr object reference handling.
 *
 * - Builds an object graph with:
 *   - Shared references
 *   - Cyclic references
 * - Serializes it with msgpackr (with structured clone extension enabled)
 * - Writes to disk
 * - Reads back and deserializes
 * - Logs checks verifying that references are preserved
 *
 * Usage:
 *   npx tsx scripts/test-msgpackr.ts
 */

import { join } from 'node:path';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { Packr } from 'msgpackr';

const OUT_DIR = join(process.cwd(), 'tmp');
const OUT_FILE = join(OUT_DIR, 'msgpackr-test.bin');

const NUM_PEOPLE = 10000;
const EDGES_PER_PERSON = 1000;

// Interned edge labels to avoid repeating strings on every edge
const EDGE_LABELS = ['friend', 'acquaintance'] as const;
type EdgeLabelId = 0 | 1;

// String table: names stored once, Person references by index to force reuse
const NAME_TABLE_SIZE = 10; // Reuse same 100 strings across all people

class Person {
  nameId: number; // index into name table
  friends: Edge[] | any[] = [];
  meta: { role: string };
  self?: Person;
  bestFriend?: Person;

  constructor(nameId: number, meta: { role: string }) {
    this.nameId = nameId;
    this.meta = meta;
  }
}

class Edge {
  from: Person;
  to: Person;
  labelId: EdgeLabelId;
  weight: number;

  constructor(from: Person, to: Person, labelId: EdgeLabelId, weight: number) {
    this.from = from;
    this.to = to;
    this.labelId = labelId;
    this.weight = weight;
  }
}

interface GraphRoot {
  nameTable: string[]; // Shared string table; Person.nameId indexes into this
  people: Person[];
  edges: Edge[];
  createdAt: Date;
  note: string;
}

function buildObjectGraph(): GraphRoot {
  const sharedMeta = { role: 'admin' };

  // String table: each entry reused by many Person objects (nameId = i % NAME_TABLE_SIZE)
  const nameTable = Array.from({ length: NAME_TABLE_SIZE }, (_, i) => `Person-${i}`);

  const people: Person[] = Array.from({ length: NUM_PEOPLE }, (_, i) => {
    const nameId = i % NAME_TABLE_SIZE;
    return new Person(nameId, sharedMeta);
  });

  // A few explicit cycles on the first two people
  const alice = people[0]!;
  const bob = people[1]!;
  alice.self = alice;
  alice.bestFriend = bob;
  bob.bestFriend = alice;

  const edges: Edge[] = [];

  // For each person, create EDGES_PER_PERSON outgoing edges to other people
  for (let i = 0; i < NUM_PEOPLE; i++) {
    const from = people[i]!;
    for (let j = 0; j < EDGES_PER_PERSON; j++) {
      const toIndex = (i + j + 1) % NUM_PEOPLE;
      const to = people[toIndex]!;
      const labelId: EdgeLabelId = j === 0 ? 0 : 1;
      const edge = new Edge(from, to, labelId, 1);
      edges.push(edge);
    }
  }

  // Attach a sample collection of edges as "friends" for the first two people,
  // to keep a smaller cyclic subgraph while the full edge set lives in root.edges.
  const firstPerson = people[0]!;
  const secondPerson = people[1]!;
  const firstPersonEdges = edges.filter((e) => e.from === firstPerson).slice(0, EDGES_PER_PERSON);
  firstPerson.friends = firstPersonEdges;
  secondPerson.friends = firstPersonEdges;

  const root: GraphRoot = {
    nameTable,
    people,
    edges,
    createdAt: new Date(),
    note: `Graph with ${NUM_PEOPLE} people and ${edges.length} edges`,
  };

  return root;
}

function getName(graph: GraphRoot, p: Person): string {
  return graph.nameTable[p.nameId] ?? `?${p.nameId}`;
}

function logGraph(label: string, graph: GraphRoot) {
  console.log(`\n=== ${label} ===`);
  console.log('note:', graph.note);
  console.log('nameTable size:', graph.nameTable.length, '(reused across', graph.people.length, 'people)');
  console.log('createdAt:', graph.createdAt instanceof Date ? graph.createdAt.toISOString() : graph.createdAt);
  console.log('people count:', graph.people.length);
  console.log('edges count:', graph.edges.length);
  const samplePeople = graph.people.slice(0, 3);
  console.log('sample people:', samplePeople.map((p) => getName(graph, p)));
  const sampleFriendEdges = (graph.people[0]?.friends as Edge[] | undefined)?.slice(0, 3) ?? [];
  console.log(
    'sample friends of first person:',
    sampleFriendEdges.map(
      (e) => `${getName(graph, e.from)} -> ${getName(graph, e.to)} (${EDGE_LABELS[e.labelId]}, w=${e.weight})`,
    ),
  );
}

function runChecks(original: GraphRoot, restored: GraphRoot) {
  console.log('\n=== Checks ===');

  // Basic shape
  console.log('people length equal:', original.people.length === restored.people.length);
  console.log('edges length equal:', original.edges.length === restored.edges.length);

  const restAlice = restored.people[0];
  const restBob = restored.people[1];

  if (!restAlice || !restBob) {
    console.log('not enough people to run further checks');
    return;
  }

  console.log(
    'first person name preserved:',
    restored.nameTable[restAlice.nameId] === original.nameTable[original.people[0].nameId],
  );

  // Shared reference: all people share the same meta object
  const sharedMetaOk =
    restored.people[0].meta === restored.people[1].meta &&
    restored.people[1].meta === restored.people[restored.people.length - 1].meta;
  console.log('shared meta reference preserved across people:', sharedMetaOk);

  // Cyclic references on first two people
  const aliceSelfOk = restAlice.self === restAlice;
  console.log('alice.self === alice (cycle):', aliceSelfOk);

  const mutualBestFriendsOk = restAlice.bestFriend === restBob && restBob.bestFriend === restAlice;
  console.log('mutual bestFriend references (person-0 <-> person-1):', mutualBestFriendsOk);

  // Edge references: check a few edges against the people array
  const edgeSample = restored.edges[0];
  const edgeRefsOk =
    !!edgeSample &&
    restored.people.includes(edgeSample.from) &&
    restored.people.includes(edgeSample.to);
  console.log('sample edge references valid Person instances:', edgeRefsOk);
}

async function main() {
  console.log('🧪 Testing msgpackr reference handling\n');
  console.log(
    `Graph config: ${NUM_PEOPLE.toLocaleString()} people, ${EDGES_PER_PERSON.toLocaleString()} edges/person (${(
      NUM_PEOPLE * EDGES_PER_PERSON
    ).toLocaleString()} edges total)`,
  );

  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

  // Measure memory before/after building the in-memory graph
  const memBefore = process.memoryUsage();
  const graph = buildObjectGraph();
  const memAfter = process.memoryUsage();
  const heapDeltaMB = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;
  console.log(
    `\nIn-memory graph heap usage delta: ${heapDeltaMB.toFixed(2)} MB (before ${(memBefore.heapUsed / 1024 / 1024).toFixed(
      2,
    )} MB, after ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)} MB)`,
  );

  // Packr with structured clone extension enabled for cycles and shared refs
  const packr = new Packr({
    structuredClone: true,
  });

  logGraph('Original graph', graph);

  const encodeStart = performance.now();
  const encoded = packr.pack(graph);
  const encodeEnd = performance.now();

  const writeStart = performance.now();
  writeFileSync(OUT_FILE, encoded);
  const writeEnd = performance.now();

  const fileSizeBytes = encoded.byteLength;
  const fileSizeMB = fileSizeBytes / 1024 / 1024;

  console.log(`\nWrote ${fileSizeBytes.toLocaleString()} bytes (${fileSizeMB.toFixed(2)} MB) to ${OUT_FILE}`);

  const readStart = performance.now();
  const loaded = readFileSync(OUT_FILE);
  const readEnd = performance.now();

  const decodeStart = performance.now();
  // Use the same Packr instance for unpacking so the structuredClone
  // behavior (cycles/shared refs) is preserved.
  const restored = packr.unpack(loaded);
  const decodeEnd = performance.now();

  console.log(
    `\nSave time (encode + write): ${(writeEnd - encodeStart).toFixed(2)} ms (encode ${(encodeEnd - encodeStart).toFixed(
      2,
    )} ms, write ${(writeEnd - encodeEnd).toFixed(2)} ms)`,
  );
  console.log(
    `Load time (read + decode): ${(decodeEnd - readStart).toFixed(2)} ms (read ${(readEnd - readStart).toFixed(
      2,
    )} ms, decode ${(decodeEnd - readEnd).toFixed(2)} ms)`,
  );

  logGraph('Restored graph', restored);
  runChecks(graph, restored);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


/**
 * Reputation aggregation for NIP-32010.
 * Counts trust/neutral/distrust and resolves latest-wins from events.
 */

import type { VerifiedEvent } from 'nostr-tools';

export interface ITrustRow {
  author_id: string;
  subject_id: string;
  subject_type?: string | null;
  context: string;
  value: number;
  event_id?: string | null;
  created_at?: number | null;
}

const SUBJECT_TAGS = ['p', 'e', 'a', 'h', 'r', 'i'] as const;
const KIND_TRUST = 32010;

export interface AggregateResult {
  trust: number;
  neutral: number;
  distrust: number;
}

function extractSubjectsFromTags(tags: string[][]): string[] {
  const kTags = tags.filter((t) => t[0] === 'k').map((t) => t[1]);
  const subjects: string[] = [];

  for (const tag of tags) {
    const [name, value] = tag;
    if (!name || !value) continue;
    const tagName = name.toLowerCase();
    if (!SUBJECT_TAGS.includes(tagName as (typeof SUBJECT_TAGS)[number])) continue;

    const canonical = value.trim().toLowerCase();
    if (tagName === 'i' && kTags[0]) {
      subjects.push(canonical);
    } else {
      subjects.push(canonical);
    }
  }
  return subjects;
}

function getContextFromTags(tags: string[][]): string {
  const cTag = tags.find((t) => t[0] === 'c');
  return cTag?.[1] ?? '';
}

function getValueFromTags(tags: string[][]): number {
  const vTag = tags.find((t) => t[0] === 'v');
  const v = vTag?.[1];
  if (v === '1') return 1;
  if (v === '-1') return -1;
  return 0;
}


export function aggregateByTarget(
  trustRows: ITrustRow[],
  context?: string
): AggregateResult {
  let rows = trustRows;
  if (context !== undefined && context !== null && context !== '') {
    rows = trustRows.filter((r) => r.context === context);
  }

  const result: AggregateResult = { trust: 0, neutral: 0, distrust: 0 };
  for (const row of rows) {
    if (row.value === 1) result.trust++;
    else if (row.value === -1) result.distrust++;
    else result.neutral++;
  }
  return result;
}


export function resolveLatestWins(
  events: VerifiedEvent[]
): Map<string, { value: number; event: VerifiedEvent }> {
  const sorted = [...events].filter((e) => e.kind === KIND_TRUST);
  sorted.sort((a, b) => a.created_at - b.created_at);

  const map = new Map<string, { value: number; event: VerifiedEvent }>();

  for (const event of sorted) {
    const author = event.pubkey.toLowerCase();
    const subjects = extractSubjectsFromTags(event.tags);
    const context = getContextFromTags(event.tags);
    const value = getValueFromTags(event.tags);

    for (const subject of subjects) {
      const key = `${author}|${subject}|${context}`;
      map.set(key, { value, event });
    }
  }

  return map;
}
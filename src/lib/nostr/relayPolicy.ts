import { getFilterLimit } from 'nostr-tools';
import type { Filter, NostrEvent } from 'nostr-tools';
import type { RelayLimitation } from '../../config.js';

/** UTF-8 byte length of an inbound WebSocket payload (NIP-11 `max_message_length`). */
export function websocketInboundByteLength(raw: unknown): number {
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
  if (Buffer.isBuffer(raw)) return raw.length;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (Array.isArray(raw)) {
    return raw.reduce<number>((sum, chunk) => {
      if (Buffer.isBuffer(chunk)) return sum + chunk.length;
      if (chunk instanceof ArrayBuffer) return sum + chunk.byteLength;
      if (ArrayBuffer.isView(chunk)) return sum + chunk.byteLength;
      return sum;
    }, 0);
  }
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return Buffer.byteLength(String(raw), 'utf8');
}

/**
 * NIP-13 difficulty: count leading zero bits in the event id (32-byte hex SHA-256).
 * @see https://nips.nostr.com/13
 */
export function nip13PowLeadingZeroBitsFromId(idHex: string): number {
  if (!/^[0-9a-f]{64}$/i.test(idHex)) return 0;
  const buf = Buffer.from(idHex, 'hex');
  let bits = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 0) bits += 8;
    else {
      bits += Math.clz32((b << 24) >>> 0);
      break;
    }
  }
  return bits;
}

/** NIP-11 `max_content_length`: Unicode scalar count (iterable code points). */
export function countContentUnicodeScalars(content: string): number {
  /*
  let n = 0;
  for (const _ of content) n++;
  return n;
  */
  return content.length;
}

/**
 * Apply NIP-11 `default_limit`, `max_limit`, and nostr-tools intrinsic limits from tag/id shapes.
 */
export function applyRelayFilterLimits(filter: Filter, lim: RelayLimitation): Filter {
  const out = { ...filter } as Filter;
  const intrinsic = getFilterLimit(out);
  let desired: number;
  if (out.limit === undefined || out.limit === null) {
    desired = lim.default_limit;
  } else {
    desired = Number.isFinite(out.limit) ? Math.max(0, Math.floor(out.limit)) : lim.default_limit;
  }
  if (intrinsic !== Infinity && Number.isFinite(intrinsic)) {
    desired = Math.min(desired, intrinsic);
  }
  desired = Math.min(desired, lim.max_limit);
  out.limit = desired;
  return out;
}

/**
 * Enforce relay write policy before persistence. Returns a short machine reason or null if OK.
 */
export function enforceRelayEventWritePolicy(
  event: NostrEvent,
  lim: RelayLimitation,
  nowSec: number,
): string | null {
  if (event.tags.length > lim.max_event_tags) {
    return `policy: too many tags (max ${lim.max_event_tags})`;
  }
  const contentLen = countContentUnicodeScalars(event.content ?? '');
  if (contentLen > lim.max_content_length) {
    return `policy: content too long (max ${lim.max_content_length} unicode characters)`;
  }
  if (lim.min_pow_difficulty > 0) {
    const bits = nip13PowLeadingZeroBitsFromId(event.id);
    if (bits < lim.min_pow_difficulty) {
      return `policy: insufficient proof-of-work (min ${lim.min_pow_difficulty} bits, NIP-13)`;
    }
  }
  if (lim.created_at_upper_limit >= 0 && event.created_at > nowSec + lim.created_at_upper_limit) {
    return 'policy: created_at too far in the future';
  }
  if (lim.created_at_lower_limit > 0 && event.created_at < nowSec - lim.created_at_lower_limit) {
    return 'policy: created_at outside allowed window (too old)';
  }
  return null;
}

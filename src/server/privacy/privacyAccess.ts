import type { RuntimeContext } from '../../lib/runtimeContext.js';
import type { Filter } from 'nostr-tools';

type PrivacyIpReason = 'abuse_prevention' | 'rate_limiting' | 'incident_response' | 'relay_write';

type PrivacyIpRecord = {
  ip: string;
  firstSeen: number;
  lastSeen: number;
  hits: number;
  reason: PrivacyIpReason;
};

const privacyIpByPubkey = new Map<string, Map<string, PrivacyIpRecord>>();

export function recordPrivacyIpForPubkey(pubkey: string, ip: string, reason: PrivacyIpReason = 'relay_write'): void {
  const normalizedPubkey = pubkey.trim().toLowerCase();
  const normalizedIp = ip.trim();
  if (!normalizedPubkey || !normalizedIp) return;

  const now = Math.floor(Date.now() / 1000);
  const existingByIp = privacyIpByPubkey.get(normalizedPubkey) ?? new Map<string, PrivacyIpRecord>();
  const existing = existingByIp.get(normalizedIp);

  if (existing) {
    existing.lastSeen = now;
    existing.hits += 1;
    existing.reason = reason;
  } else {
    existingByIp.set(normalizedIp, {
      ip: normalizedIp,
      firstSeen: now,
      lastSeen: now,
      hits: 1,
      reason,
    });
  }

  privacyIpByPubkey.set(normalizedPubkey, existingByIp);
}

function getPrivacyIpRecords(pubkey: string): PrivacyIpRecord[] {
  const rows = privacyIpByPubkey.get(pubkey.trim().toLowerCase());
  if (!rows) return [];
  return [...rows.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

export async function buildPrivacyAccessPayload(pubkey: string, runtimeContext: RuntimeContext) {
  const normalizedPubkey = pubkey.trim().toLowerCase();
  const store = runtimeContext.store;
  const now = Math.floor(Date.now() / 1000);

  let publicEventSampleCount = 0;
  let publicEventSampleTruncated = false;
  const publicEventSampleLimit = 500;

  if (store) {
    const filters: Filter[] = [{ authors: [normalizedPubkey], limit: publicEventSampleLimit + 1 }];
    const events = await store.query(filters, {});
    publicEventSampleCount = Math.min(events.length, publicEventSampleLimit);
    publicEventSampleTruncated = events.length > publicEventSampleLimit;
  }

  const ipRecords = getPrivacyIpRecords(normalizedPubkey);
  const ipRetentionDays = Number(process.env.TRUST_PRIVACY_IP_RETENTION_DAYS || 30);

  return {
    subject: {
      pubkey: normalizedPubkey,
      authenticatedVia: 'nip-98',
    },
    processing: {
      purposes: ['relay_operation', 'abuse_prevention', 'rate_limiting', 'incident_response'],
      legalBasis: ['legitimate_interests'],
    },
    dataCategories: {
      publicNostrEvents: {
        stored: true,
        sampleCount: publicEventSampleCount,
        sampleLimit: publicEventSampleLimit,
        truncated: publicEventSampleTruncated,
      },
      ipLogs: {
        stored: true,
        collectedOnlyWhenNeeded: ['abuse_prevention', 'rate_limiting', 'incident_response'],
        records: ipRecords,
      },
    },
    retention: {
      ipLogsDays: ipRetentionDays,
      note: 'IP records are retained only as needed for abuse/security handling and deleted per retention policy.',
    },
    deletion: {
      supportedNips: [9, 62],
      scope: 'best_effort_relay_local_only',
      networkLimit: 'Deletion cannot be guaranteed on third-party relays, caches, archives, or clients.',
    },
    generatedAt: now,
  };
}

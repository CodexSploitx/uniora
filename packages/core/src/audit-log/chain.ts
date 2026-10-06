/**
 * Hash chain over the audit log (audit F-04). Each entry's hash covers its own
 * content AND the previous entry's hash, so changing or removing any entry
 * breaks every hash after it.
 *
 * Used by the in-memory and SQLite storage. The Postgres adapter computes the
 * same idea inside the database (a trigger), so a writer that bypasses the
 * application can't skip it.
 */

import type { AuditIntegrityReport } from "./types.js";

interface DigestCrypto {
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
}

export interface ChainedAuditFields {
  id: string;
  organizationId: string | null;
  actorProvider: string;
  actorSubject: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  /** `JSON.stringify(metadata)`, or `null`. The exact text is what gets hashed. */
  metadataJson: string | null;
  /** ISO-8601 with milliseconds, UTC. */
  createdAt: string;
}

export async function computeAuditEntryHash(prevHash: string | null, fields: ChainedAuditFields): Promise<string> {
  const crypto = (globalThis as { crypto?: DigestCrypto }).crypto;
  if (!crypto?.subtle) throw new Error("@uniora/core needs Web Crypto (globalThis.crypto) to chain audit entries — use Node 19+.");
  const text = JSON.stringify([
    prevHash,
    fields.id,
    fields.organizationId,
    fields.actorProvider,
    fields.actorSubject,
    fields.action,
    fields.targetType,
    fields.targetId,
    fields.metadataJson,
    fields.createdAt,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Folds an external anchor into a verification report (audit F-04): the anchored position must still
 * hold the anchored hash. Only meaningful when the chain itself verified (`report.ok`).
 */
export async function applyAnchor(
  report: AuditIntegrityReport,
  anchor: { position: number; hash: string } | undefined,
  hashAt: (position: number) => Promise<string | null>,
): Promise<AuditIntegrityReport> {
  if (!anchor || !report.ok) return report;
  const found = await hashAt(anchor.position);
  const status = found === null ? "missing" : found === anchor.hash ? "valid" : "mismatch";
  return { ...report, anchor: status, ok: status === "valid" };
}

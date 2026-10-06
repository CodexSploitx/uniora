import type { UnioraStorage } from "@uniora/core";

/**
 * Raw access to the adapter's database for the few assertions that must
 * look *underneath* the repositories — either to forge a row the public API
 * (rightly) refuses to produce, or to prove a repository left nothing
 * behind. Each adapter implements these in its own SQL dialect; the suite
 * itself stays SQL-free.
 */
export interface StorageProbe {
  /**
   * Inserts a `membership_roles` row directly, bypassing every repository
   * guard (same-organization check, Owner-role split, ...). Used to prove
   * the AuthorizationEngine's own defense-in-depth against a corrupted row.
   */
  forgeMembershipRole(membershipId: string, roleId: string): Promise<void>;
  /** Whether a `membership_roles` row exists for this exact pair. */
  hasMembershipRole(membershipId: string, roleId: string): Promise<boolean>;
  /** Total number of persisted identity links. */
  countIdentityLinks(): Promise<number>;
  /** Number of audit entries recorded with this exact `action`. */
  countAuditEntries(action: string): Promise<number>;
}

/**
 * How the conformance suite drives one concrete adapter. The suite owns the
 * lifecycle hooks (`beforeAll`/`afterAll`/`beforeEach`), so an adapter's own
 * test file is just `defineStorageConformance(harness)`.
 */
export interface StorageHarness {
  /** Shown in the test titles, e.g. `"@uniora/sqlite"`. */
  readonly name: string;
  /** Connect and bring the schema up to date (once, before any test). */
  setup(): Promise<void>;
  /** Release the connection (once, after every test). */
  teardown(): Promise<void>;
  /** Remove every row from every UNIORA table (before each test). */
  reset(): Promise<void>;
  /** A storage bound to the already-set-up database. Called once per test. */
  storage(): UnioraStorage;
  readonly probe: StorageProbe;
}

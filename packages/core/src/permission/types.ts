/**
 * A concrete action, e.g. "vehicles.create" (docs/PROYECT.md §5).
 * Permission keys form a global catalog shared by every organization.
 */
export interface Permission {
  readonly key: string;
  /** Optional display label — the `key` itself is usually self-descriptive enough. */
  name?: string;
  description?: string;
  /** Section of the catalog this permission belongs to, e.g. `"Appointments"`; for grouping in a role editor. At most 100 characters. */
  group?: string;
  /**
   * Permissions this one grants as well, e.g. `appointments.write` implies `appointments.read`: a role that holds
   * `write` passes a check for `read` without holding it. Direct implications only (the closure is followed
   * transitively), sorted. See `PermissionRepository.register`.
   */
  implies?: string[];
}

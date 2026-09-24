/**
 * A concrete action, e.g. "vehicles.create" (docs/PROYECT.md §5).
 * Permission keys form a global catalog shared by every organization.
 */
export interface Permission {
  readonly key: string;
  /** Optional display label — the `key` itself is usually self-descriptive enough. */
  name?: string;
  description?: string;
}

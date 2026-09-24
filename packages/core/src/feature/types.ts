/**
 * A capability toggled per organization — distinct from a Permission
 * (docs/PROYECT.md §28): "¿Qué tiene habilitado la organización?"
 */
export interface Feature {
  readonly organizationId: string;
  readonly key: string;
  enabled: boolean;
}

/**
 * A catalog entry: the definition of a feature that can be toggled for an
 * organization. `enable`/`disable` reject a `key` that was never
 * registered here (fail-closed — uniora-security-engineering INV-007,
 * "Unknown Features Deny" — extended to creation time, not just
 * evaluation). Distinct from `Feature`: this is the global definition
 * (like `Permission`), `Feature` is the per-organization toggle.
 */
export interface FeatureDefinition {
  readonly key: string;
  name: string;
  description?: string;
}

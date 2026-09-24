/**
 * Reference to an identity owned by the application's auth provider.
 * UNIORA never owns identity — it only stores this pointer (see docs/PROYECT.md §14).
 */
export interface Identity {
  readonly provider: string;
  readonly subject: string;
}

export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.provider === b.provider && a.subject === b.subject;
}

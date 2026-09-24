export interface Organization {
  readonly id: string;
  /** URL-safe handle, unique across every organization. See `resolveOrganizationSlug`. */
  slug: string;
  name: string;
  readonly createdAt: Date;
}

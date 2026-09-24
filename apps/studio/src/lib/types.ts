export interface IdentityView {
  provider: string;
  subject: string;
}

export interface ActivityItem {
  id: string;
  organizationId: string;
  organizationName: string;
  action: string;
  actor: IdentityView;
  target?: { type: string; id: string };
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  memberCount: number;
  roleCount: number;
  enabledFeatureCount: number;
}

export interface RoleRef {
  id: string;
  name: string;
  isOwnerRole: boolean;
}

/** A member with its roles already resolved to names (never raw role ids the client would have to look up). */
export interface MemberRow {
  id: string;
  identity: IdentityView;
  /** A short preview only (Owner first, then alphabetical) — never every role a member holds. */
  roles: RoleRef[];
  /** How many roles the member holds in total (`roles.length` may be smaller). */
  roleCount: number;
  /** Set on the global members page, where rows come from many organizations. */
  organization?: { id: string; name: string };
}

/** A role as listed for an organization — counts only, never its permission list. */
export interface RoleRow {
  id: string;
  key: string;
  name: string;
  isOwnerRole: boolean;
  permissionCount: number;
  memberCount: number;
}

export interface MemberHeader {
  id: string;
  identity: IdentityView;
  organization: { id: string; name: string };
  /** Holds the protected Owner role: full access by design (a flag, not a list). */
  isOwner: boolean;
  roleCount: number;
  /** Effective permissions; for an Owner, the size of the whole catalog. */
  permissionCount: number;
  /** Features enabled for the member's organization (features are per organization, not per member). */
  featureCount: number;
  /** A few of the identity's OTHER memberships (other organizations), plus how many exist. */
  otherOrganizations: { membershipId: string; organization: { id: string; name: string } }[];
  otherOrganizationsTotal: number;
}

/** An effective permission and WHY the member has it: a preview of the held roles that grant it. */
export interface MemberPermissionRow {
  key: string;
  name?: string;
  description?: string;
  via: { roles: RoleRef[]; total: number };
}

export interface RolePermissionRow {
  key: string;
  name?: string;
  description?: string;
  granted: boolean;
}

export interface OrgHeader {
  organization: { id: string; slug: string; name: string; createdAt: string };
  memberCount: number;
  roleCount: number;
  featuresEnabled: number;
  featuresTotal: number;
}

export interface PermissionView {
  key: string;
  name?: string;
  description?: string;
  grantedRoleCount: number;
}

export interface FeatureView {
  key: string;
  name: string;
  description?: string;
  /** How many organizations have it enabled. */
  enabledCount: number;
  /** A few of those organizations, for a "used by…" preview (never the full list). */
  sampleOrganizations: { id: string; name: string }[];
}

export interface OrgFeatureToggle {
  key: string;
  name: string;
  description?: string;
  enabled: boolean;
}

export interface OverviewData {
  /** Only the first few organizations (a preview), never the whole table. */
  organizations: OrgSummary[];
  organizationCount: number;
  permissionCount: number;
  featureCount: number;
  memberCount: number;
  roleCount: number;
  recentActivity: ActivityItem[];
}

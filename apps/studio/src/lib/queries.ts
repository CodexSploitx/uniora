import "server-only";
import type { AuditLogEntry, Organization } from "@uniora/core";
import { getPool, getStorage } from "@/lib/db";
import { requireSession } from "@/lib/session";
import type {
  ActivityItem,
  FeatureView,
  MemberHeader,
  MemberPermissionRow,
  MemberRow,
  OrgFeatureToggle,
  OrgHeader,
  OrgSummary,
  OverviewData,
  PermissionView,
  RolePermissionRow,
  RoleRef,
  RoleRow,
} from "@/lib/types";

/** Data Access Layer: every read verifies the Studio session itself. */

// Once the schema exists it stays for the life of this process — only a
// positive answer is cached, so a missing schema is re-checked on every
// request (and the "run uniora migrate" guidance disappears as soon as it's
// applied). Saves one query per navigation across the whole app.
let schemaKnownReady = false;

export async function isSchemaReady(): Promise<boolean> {
  await requireSession();
  if (schemaKnownReady) return true;
  const result = await getPool().query("select 1 from information_schema.schemata where schema_name = 'uniora'");
  schemaKnownReady = (result.rowCount ?? 0) > 0;
  return schemaKnownReady;
}

function toActivity(entry: AuditLogEntry, organizationName: string): ActivityItem {
  return {
    id: entry.id,
    organizationId: entry.organizationId,
    organizationName,
    action: entry.action,
    actor: { provider: entry.actor.provider, subject: entry.actor.subject },
    target: entry.target ? { type: entry.target.type, id: entry.target.id } : undefined,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * Turns audit entries into view items, resolving each distinct organization
 * name with ONE batched `findByIds` (never a lookup per entry).
 */
async function toActivityItems(entries: AuditLogEntry[]): Promise<ActivityItem[]> {
  const organizationIds = [...new Set(entries.map((entry) => entry.organizationId))];
  const organizations = await getStorage().organizations.findByIds(organizationIds);
  const nameById = new Map(organizations.map((organization) => [organization.id, organization.name]));
  return entries.map((entry) => toActivity(entry, nameById.get(entry.organizationId) ?? entry.organizationId));
}

/**
 * Summarizes a batch of organizations (members / roles / enabled features)
 * with THREE grouped queries in total — one per counter, each covering every
 * organization in the batch — never three queries per organization.
 */
async function summarizeMany(organizations: Organization[]): Promise<OrgSummary[]> {
  const storage = getStorage();
  const ids = organizations.map((organization) => organization.id);
  const [members, roles, enabledFeatures] = await Promise.all([
    storage.memberships.countByOrganization(ids),
    storage.roles.countByOrganization(ids),
    storage.features.countEnabledByOrganization(ids),
  ]);
  return organizations.map((organization) => ({
    id: organization.id,
    slug: organization.slug,
    name: organization.name,
    createdAt: organization.createdAt.toISOString(),
    memberCount: members[organization.id] ?? 0,
    roleCount: roles[organization.id] ?? 0,
    enabledFeatureCount: enabledFeatures[organization.id] ?? 0,
  }));
}

export interface OrganizationsPage {
  items: OrgSummary[];
  nextCursor: string | null;
  /** Total organizations matching the current search query (or all, if none). */
  total: number;
}

const ORGANIZATIONS_PAGE_SIZE = 24;

function encodeOrganizationCursor(organization: { createdAt: Date; id: string }): string {
  return `${organization.createdAt.toISOString()}_${organization.id}`;
}

function decodeOrganizationCursor(cursor: string): { createdAt: Date; id: string } | undefined {
  const separator = cursor.indexOf("_");
  if (separator === -1) return undefined;
  const createdAt = new Date(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return undefined;
  return { createdAt, id };
}

/**
 * Paginated, optionally search-filtered listing for the `/organizations`
 * page — never loads every organization at once. Pages with a keyset
 * cursor (`OrganizationRepository.search`), never `offset`, for the same
 * reason as `getActivityPage`: organizations keep being created underneath
 * any given page. Each returned organization is still summarized
 * (members/roles/features counts), but only for this page's rows, not the
 * whole table.
 */
export async function getOrganizationsPage(options?: { query?: string; cursor?: string }): Promise<OrganizationsPage> {
  await requireSession();
  const storage = getStorage();
  const query = options?.query?.trim() || undefined;
  const after = options?.cursor ? decodeOrganizationCursor(options.cursor) : undefined;

  const [rows, total] = await Promise.all([
    storage.organizations.search({ limit: ORGANIZATIONS_PAGE_SIZE + 1, after, query }),
    storage.organizations.count({ query }),
  ]);
  const hasMore = rows.length > ORGANIZATIONS_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, ORGANIZATIONS_PAGE_SIZE) : rows;

  return {
    items: await summarizeMany(page),
    nextCursor: hasMore ? encodeOrganizationCursor(page[page.length - 1]!) : null,
    total,
  };
}

/**
 * Lightweight organization list for the app shell's sidebar (badge count +
 * "Jump to organization" shortcuts) — runs on every navigation, so unlike
 * the Overview/`/organizations` summaries it must never load the whole table.
 */
export async function getSidebarOrganizations(): Promise<{ items: { id: string; name: string }[]; total: number }> {
  await requireSession();
  const storage = getStorage();
  const [rows, total] = await Promise.all([storage.organizations.search({ limit: 12 }), storage.organizations.count()]);
  return { items: rows.map(({ id, name }) => ({ id, name })), total };
}

/**
 * Overview data — every figure is an aggregate or a bounded page, so cost
 * does not grow with the number of organizations: totals come from `count()`
 * queries, the organization list is only the first `organizationLimit`
 * (summarized in batch), and recent activity is the newest entries overall.
 */
export async function getOverview(organizationLimit: number): Promise<OverviewData> {
  await requireSession();
  const storage = getStorage();
  const [organizationRows, organizationCount, memberCount, roleCount, permissionCount, featureCount, recentEntries] =
    await Promise.all([
      storage.organizations.search({ limit: organizationLimit }),
      storage.organizations.count(),
      storage.memberships.count(),
      storage.roles.count(),
      storage.permissions.count(),
      storage.features.count(),
      storage.auditLogs.listRecent({ limit: 8 }),
    ]);

  const [organizations, recentActivity] = await Promise.all([summarizeMany(organizationRows), toActivityItems(recentEntries)]);

  return { organizations, organizationCount, permissionCount, featureCount, memberCount, roleCount, recentActivity };
}

// ---------------------------------------------------------------------------
// Organization detail. Every tab is loaded on its own, one bounded page at a
// time, and written as if the organization held thousands of members, roles,
// permissions, features and audit entries: nothing here ever loads "all of"
// anything, and lists are keyset-paged (never offset) with counts from
// count() queries.
// ---------------------------------------------------------------------------

const MEMBERS_PAGE_SIZE = 25;
const ROLES_PAGE_SIZE = 20;
const ROLE_PERMISSIONS_PAGE_SIZE = 30;
const ORG_FEATURES_PAGE_SIZE = 25;
const ORG_ACTIVITY_PAGE_SIZE = 25;
const MAX_QUERY_LENGTH = 100;
const MAX_CURSOR_LENGTH = 256;

const cleanQuery = (query?: string): string | undefined => query?.trim().slice(0, MAX_QUERY_LENGTH) || undefined;
const cleanCursor = (cursor?: string): string | undefined =>
  cursor && cursor.length <= MAX_CURSOR_LENGTH ? cursor : undefined;

/** Splits one over-fetched row off a page: `limit + 1` rows are requested only to learn whether another page exists. */
function splitPage<T>(rows: T[], limit: number): { page: T[]; hasMore: boolean } {
  const hasMore = rows.length > limit;
  return { page: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

export async function getOrgHeader(id: string): Promise<OrgHeader | null> {
  await requireSession();
  const storage = getStorage();
  const organization = await storage.organizations.findById(id);
  if (!organization) return null;

  const [memberCount, roleCount, featuresEnabled, featuresTotal] = await Promise.all([
    storage.memberships.count({ organizationId: id }),
    storage.roles.count({ organizationId: id }),
    storage.features.count({ enabledIn: id }),
    storage.features.count(),
  ]);
  return {
    organization: {
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      createdAt: organization.createdAt.toISOString(),
    },
    memberCount,
    roleCount,
    featuresEnabled,
    featuresTotal,
  };
}

/** Roles shown inline per member; the rest live behind a "+N more" popover loaded on demand. */
const ROLES_PREVIEW = 3;

const toMemberRow = (listing: {
  id: string;
  identity: { provider: string; subject: string };
  roleCount: number;
  roles: { id: string; name: string; isOwnerRole: boolean }[];
}): MemberRow => ({
  id: listing.id,
  identity: { provider: listing.identity.provider, subject: listing.identity.subject },
  roleCount: listing.roleCount,
  roles: listing.roles.map((role) => ({ id: role.id, name: role.name, isOwnerRole: role.isOwnerRole })),
});

export interface OrgMembersPage {
  items: MemberRow[];
  nextCursor: string | null;
  total: number;
  /** Members holding the Owner role — lets the UI flag the last owner without loading every member. */
  ownerRoleId?: string;
  ownerCount: number;
}

export async function getOrgMembersPage(
  organizationId: string,
  options?: { query?: string; cursor?: string },
): Promise<OrgMembersPage> {
  await requireSession();
  const storage = getStorage();
  const query = cleanQuery(options?.query);
  const [rows, total] = await Promise.all([
    storage.memberships.searchListing({
      organizationId,
      limit: MEMBERS_PAGE_SIZE + 1,
      after: cleanCursor(options?.cursor),
      query,
      rolesPerMember: ROLES_PREVIEW,
    }),
    storage.memberships.count({ organizationId, query }),
  ]);
  const { page, hasMore } = splitPage(rows, MEMBERS_PAGE_SIZE);
  // The Owner role always sorts first in a member's preview, so it is visible whenever they hold it.
  const ownerRoleId = page.flatMap((member) => member.roles).find((role) => role.isOwnerRole)?.id;
  const ownerCount = ownerRoleId ? ((await storage.memberships.countByRole([ownerRoleId]))[ownerRoleId] ?? 0) : 0;

  return {
    items: page.map(toMemberRow),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
    total,
    ownerRoleId,
    ownerCount,
  };
}

export interface MembersPage {
  items: MemberRow[];
  nextCursor: string | null;
  total: number;
}

/** Members across EVERY organization (the global `/members` page): one bounded, keyset-paged, searchable page. */
export async function getMembersPage(options?: { query?: string; cursor?: string }): Promise<MembersPage> {
  await requireSession();
  const storage = getStorage();
  const query = cleanQuery(options?.query);
  const [rows, total] = await Promise.all([
    storage.memberships.searchListing({
      limit: MEMBERS_PAGE_SIZE + 1,
      after: cleanCursor(options?.cursor),
      query,
      rolesPerMember: ROLES_PREVIEW,
    }),
    storage.memberships.count({ query }),
  ]);
  const { page, hasMore } = splitPage(rows, MEMBERS_PAGE_SIZE);
  const organizations = await storage.organizations.findByIds([...new Set(page.map((membership) => membership.organizationId))]);
  const organizationById = new Map(organizations.map((organization) => [organization.id, { id: organization.id, name: organization.name }]));
  const items = page.map((membership) => ({
    ...toMemberRow(membership),
    organization: organizationById.get(membership.organizationId),
  }));

  return { items, nextCursor: hasMore ? page[page.length - 1]!.id : null, total };
}

export interface OrgRolesPage {
  items: RoleRow[];
  nextCursor: string | null;
  total: number;
}

export async function getOrgRolesPage(
  organizationId: string,
  options?: { query?: string; cursor?: string },
): Promise<OrgRolesPage> {
  await requireSession();
  const storage = getStorage();
  const query = cleanQuery(options?.query);
  const [rows, total] = await Promise.all([
    storage.roles.search({ organizationId, limit: ROLES_PAGE_SIZE + 1, after: cleanCursor(options?.cursor), query }),
    storage.roles.count({ organizationId, query }),
  ]);
  const { page, hasMore } = splitPage(rows, ROLES_PAGE_SIZE);
  const ids = page.map((role) => role.id);
  const [permissionCounts, memberCounts] = await Promise.all([
    storage.roles.countPermissions(ids),
    storage.memberships.countByRole(ids),
  ]);

  return {
    items: page.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      isOwnerRole: role.isOwnerRole,
      permissionCount: permissionCounts[role.id] ?? 0,
      memberCount: memberCounts[role.id] ?? 0,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.key : null,
    total,
  };
}

export interface RolePermissionsPage {
  role: RoleRow;
  items: RolePermissionRow[];
  nextCursor: string | null;
  /** Permissions matching the current filters (search / "granted only"). */
  total: number;
}

/**
 * One role's permissions: a bounded page of the permission catalog, each row
 * annotated with whether THIS role has it (`grantedPermissionKeys` for the
 * page's keys only). This replaces the old roles × permissions grid, which
 * cannot exist at scale — it is that grid's column for a single role, paged.
 */
export async function getRolePermissionsPage(
  organizationId: string,
  roleId: string,
  options?: { query?: string; cursor?: string; grantedOnly?: boolean },
): Promise<RolePermissionsPage | null> {
  await requireSession();
  const storage = getStorage();
  const [summary] = await storage.roles.findSummariesByIds([roleId]);
  // A role id from another organization is treated as "not found" — never shown or editable here.
  if (!summary || summary.organizationId !== organizationId) return null;

  const [permissionCounts, memberCounts] = await Promise.all([
    storage.roles.countPermissions([roleId]),
    storage.memberships.countByRole([roleId]),
  ]);
  const role: RoleRow = {
    id: summary.id,
    key: summary.key,
    name: summary.name,
    isOwnerRole: summary.isOwnerRole,
    permissionCount: permissionCounts[roleId] ?? 0,
    memberCount: memberCounts[roleId] ?? 0,
  };
  // The Owner role has full access by design (a flag, not a list): nothing to page or edit.
  if (summary.isOwnerRole) return { role, items: [], nextCursor: null, total: 0 };

  const query = cleanQuery(options?.query);
  const grantedToRole = options?.grantedOnly ? roleId : undefined;
  const [rows, total] = await Promise.all([
    storage.permissions.search({ limit: ROLE_PERMISSIONS_PAGE_SIZE + 1, after: cleanCursor(options?.cursor), query, grantedToRole }),
    storage.permissions.count({ query, grantedToRole }),
  ]);
  const { page, hasMore } = splitPage(rows, ROLE_PERMISSIONS_PAGE_SIZE);
  const granted = new Set(await storage.roles.grantedPermissionKeys(roleId, page.map((permission) => permission.key)));

  return {
    role,
    items: page.map((permission) => ({
      key: permission.key,
      name: permission.name,
      description: permission.description,
      granted: granted.has(permission.key),
    })),
    nextCursor: hasMore ? page[page.length - 1]!.key : null,
    total,
  };
}

export interface OrgFeaturesPage {
  items: OrgFeatureToggle[];
  nextCursor: string | null;
  total: number;
}

export async function getOrgFeaturesPage(
  organizationId: string,
  options?: { query?: string; cursor?: string; enabledOnly?: boolean },
): Promise<OrgFeaturesPage> {
  await requireSession();
  const storage = getStorage();
  const query = cleanQuery(options?.query);
  const enabledIn = options?.enabledOnly ? organizationId : undefined;
  const [rows, total] = await Promise.all([
    storage.features.search({ limit: ORG_FEATURES_PAGE_SIZE + 1, after: cleanCursor(options?.cursor), query, enabledIn }),
    storage.features.count({ query, enabledIn }),
  ]);
  const { page, hasMore } = splitPage(rows, ORG_FEATURES_PAGE_SIZE);
  const enabled = new Set(await storage.features.enabledKeys(organizationId, page.map((definition) => definition.key)));

  return {
    items: page.map((definition) => ({
      key: definition.key,
      name: definition.name,
      description: definition.description,
      enabled: enabled.has(definition.key),
    })),
    nextCursor: hasMore ? page[page.length - 1]!.key : null,
    total,
  };
}

// ---------------------------------------------------------------------------
// Member detail (`/members/[id]`): one membership = one identity in ONE
// organization. Same rule as the organization detail: bounded, keyset-paged,
// searchable pages — a member may hold hundreds of roles / thousands of
// effective permissions.
// ---------------------------------------------------------------------------

const MEMBER_ROLES_PAGE_SIZE = 20;
const MEMBER_PERMISSIONS_PAGE_SIZE = 30;
const MEMBER_FEATURES_PAGE_SIZE = 25;
const OTHER_ORGANIZATIONS_PREVIEW = 5;
const PERMISSION_VIA_PREVIEW = 3;

export async function getMemberHeader(membershipId: string): Promise<MemberHeader | null> {
  await requireSession();
  const storage = getStorage();
  const member = await storage.memberships.findById(membershipId);
  if (!member) return null;

  const organizationId = member.organizationId;
  const [organization, roleCount, ownerRoles, featureCount, others, othersTotal] = await Promise.all([
    storage.organizations.findById(organizationId),
    storage.roles.count({ organizationId, heldBy: membershipId }),
    storage.roles.count({ organizationId, heldBy: membershipId, isOwnerRole: true }),
    storage.features.count({ enabledIn: organizationId }),
    storage.memberships.search({ identity: member.identity, limit: OTHER_ORGANIZATIONS_PREVIEW + 1 }),
    storage.memberships.count({ identity: member.identity }),
  ]);
  if (!organization) return null;

  const isOwner = ownerRoles > 0;
  const permissionCount = isOwner
    ? await storage.permissions.count()
    : await storage.permissions.count({ grantedToMember: membershipId });

  const otherMemberships = others.filter((other) => other.id !== membershipId).slice(0, OTHER_ORGANIZATIONS_PREVIEW);
  const otherOrganizations = await storage.organizations.findByIds([...new Set(otherMemberships.map((other) => other.organizationId))]);
  const nameById = new Map(otherOrganizations.map((org) => [org.id, org.name]));

  return {
    id: member.id,
    identity: { provider: member.identity.provider, subject: member.identity.subject },
    organization: { id: organization.id, name: organization.name },
    isOwner,
    roleCount,
    permissionCount,
    featureCount,
    otherOrganizations: otherMemberships.flatMap((other) => {
      const name = nameById.get(other.organizationId);
      return name === undefined ? [] : [{ membershipId: other.id, organization: { id: other.organizationId, name } }];
    }),
    otherOrganizationsTotal: Math.max(0, othersTotal - 1),
  };
}

export async function getMemberRolesPage(
  organizationId: string,
  membershipId: string,
  options?: { query?: string; cursor?: string },
): Promise<OrgRolesPage> {
  await requireSession();
  const storage = getStorage();
  const query = cleanQuery(options?.query);
  const [rows, total] = await Promise.all([
    storage.roles.search({ organizationId, heldBy: membershipId, limit: MEMBER_ROLES_PAGE_SIZE + 1, after: cleanCursor(options?.cursor), query }),
    storage.roles.count({ organizationId, heldBy: membershipId, query }),
  ]);
  const { page, hasMore } = splitPage(rows, MEMBER_ROLES_PAGE_SIZE);
  const ids = page.map((role) => role.id);
  const [permissionCounts, memberCounts] = await Promise.all([
    storage.roles.countPermissions(ids),
    storage.memberships.countByRole(ids),
  ]);
  return {
    items: page.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      isOwnerRole: role.isOwnerRole,
      permissionCount: permissionCounts[role.id] ?? 0,
      memberCount: memberCounts[role.id] ?? 0,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.key : null,
    total,
  };
}

export interface MemberPermissionsPage {
  items: MemberPermissionRow[];
  nextCursor: string | null;
  total: number;
}

/** The member's effective permissions (union over ALL held roles), each with the roles that grant it. */
export async function getMemberPermissionsPage(
  membershipId: string,
  options?: { query?: string; cursor?: string },
): Promise<MemberPermissionsPage> {
  await requireSession();
  const storage = getStorage();
  const query = cleanQuery(options?.query);
  const [rows, total] = await Promise.all([
    storage.permissions.search({ limit: MEMBER_PERMISSIONS_PAGE_SIZE + 1, after: cleanCursor(options?.cursor), query, grantedToMember: membershipId }),
    storage.permissions.count({ query, grantedToMember: membershipId }),
  ]);
  const { page, hasMore } = splitPage(rows, MEMBER_PERMISSIONS_PAGE_SIZE);
  const granting = await storage.roles.grantingRoles(
    membershipId,
    page.map((permission) => permission.key),
    PERMISSION_VIA_PREVIEW,
  );
  return {
    items: page.map((permission) => ({
      key: permission.key,
      name: permission.name,
      description: permission.description,
      via: {
        total: granting[permission.key]?.total ?? 0,
        roles: (granting[permission.key]?.roles ?? []).map((role) => ({ id: role.id, name: role.name, isOwnerRole: role.isOwnerRole })),
      },
    })),
    nextCursor: hasMore ? page[page.length - 1]!.key : null,
    total,
  };
}

export async function getMemberFeaturesPage(
  organizationId: string,
  options?: { query?: string; cursor?: string },
): Promise<OrgFeaturesPage> {
  await requireSession();
  const storage = getStorage();
  const query = cleanQuery(options?.query);
  const [rows, total] = await Promise.all([
    storage.features.search({ limit: MEMBER_FEATURES_PAGE_SIZE + 1, after: cleanCursor(options?.cursor), query, enabledIn: organizationId }),
    storage.features.count({ query, enabledIn: organizationId }),
  ]);
  const { page, hasMore } = splitPage(rows, MEMBER_FEATURES_PAGE_SIZE);
  return {
    items: page.map((definition) => ({ key: definition.key, name: definition.name, description: definition.description, enabled: true })),
    nextCursor: hasMore ? page[page.length - 1]!.key : null,
    total,
  };
}

export async function getOrgActivityPage(organizationId: string, organizationName: string, cursor?: string): Promise<ActivityPage> {
  await requireSession();
  const before = cleanCursor(cursor) ? decodeCursor(cursor as string) : undefined;
  const entries = await getStorage().auditLogs.listByOrganization(organizationId, { limit: ORG_ACTIVITY_PAGE_SIZE + 1, before });
  const { page, hasMore } = splitPage(entries, ORG_ACTIVITY_PAGE_SIZE);
  return {
    items: page.map((entry) => toActivity(entry, organizationName)),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1] as AuditLogEntry) : null,
  };
}

/** Role picker lookup (typeahead): a handful of roles of ONE organization matching `query`, optionally only those a member does NOT hold yet. */
export async function searchOrgRoles(organizationId: string, query?: string, notHeldBy?: string): Promise<RoleRef[]> {
  await requireSession();
  const roles = await getStorage().roles.search({ organizationId, limit: 10, query: cleanQuery(query), notHeldBy });
  return roles.map((role) => ({ id: role.id, name: role.name, isOwnerRole: role.isOwnerRole }));
}

const MEMBER_ROLES_POPOVER_SIZE = 20;

/**
 * "All roles of this member" (the "+N more" popover): a bounded, searchable
 * page of the roles ONE membership holds, plus how many match. The membership
 * must belong to `organizationId` — a mismatched pair returns nothing.
 */
export async function lookupMemberRoles(
  organizationId: string,
  membershipId: string,
  query?: string,
): Promise<{ roles: RoleRef[]; total: number }> {
  await requireSession();
  const storage = getStorage();
  const member = await storage.memberships.findById(membershipId);
  if (!member || member.organizationId !== organizationId) return { roles: [], total: 0 };
  const cleaned = cleanQuery(query);
  const [roles, total] = await Promise.all([
    storage.roles.search({ organizationId, heldBy: membershipId, limit: MEMBER_ROLES_POPOVER_SIZE, query: cleaned }),
    storage.roles.count({ organizationId, heldBy: membershipId, query: cleaned }),
  ]);
  return { roles: roles.map((role) => ({ id: role.id, name: role.name, isOwnerRole: role.isOwnerRole })), total };
}

export interface ActivityPage {
  items: ActivityItem[];
  /** Opaque keyset cursor for the next page, or `null` if this was the last one. */
  nextCursor: string | null;
}

const ACTIVITY_PAGE_SIZE = 50;

function encodeCursor(entry: AuditLogEntry): string {
  return `${entry.createdAt.toISOString()}_${entry.id}`;
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | undefined {
  const separator = cursor.indexOf("_");
  if (separator === -1) return undefined;
  const createdAt = new Date(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return undefined;
  return { createdAt, id };
}

/**
 * The global activity feed (every organization, not just the 8-entry
 * preview on Overview or one organization's own tab) — paginated with a
 * keyset cursor (`AuditLogRepository.listRecent`), never `offset`, so pages
 * stay correct even as new entries keep being appended underneath it.
 */
export async function getActivityPage(cursor?: string): Promise<ActivityPage> {
  await requireSession();
  const storage = getStorage();
  const before = cursor ? decodeCursor(cursor) : undefined;

  // Ask for one extra row, only to know whether a next page exists —
  // never returned to the caller.
  const entries = await storage.auditLogs.listRecent({ limit: ACTIVITY_PAGE_SIZE + 1, before });
  const hasMore = entries.length > ACTIVITY_PAGE_SIZE;
  const page = hasMore ? entries.slice(0, ACTIVITY_PAGE_SIZE) : entries;

  return {
    items: await toActivityItems(page),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1] as AuditLogEntry) : null,
  };
}

export interface PermissionsPage {
  items: PermissionView[];
  /** `key` of the last item when more remain, else `null` (permission keys are the keyset cursor). */
  nextCursor: string | null;
  /** Total permissions matching the current search query (or all, if none). */
  total: number;
}

const PERMISSIONS_PAGE_SIZE = 50;

/**
 * Paginated, optionally search-filtered permission catalog for `/permissions`
 * — never loads the whole catalog. Keyset paging on `key` (the primary key,
 * so the cursor is exact). "Granted to N roles" is computed for this page's
 * keys only, with a single grouped query (`countRoleGrants`) instead of
 * walking every organization's roles.
 */
export async function getPermissionsPage(options?: { query?: string; cursor?: string }): Promise<PermissionsPage> {
  await requireSession();
  const storage = getStorage();
  const query = options?.query?.trim() || undefined;
  const after = options?.cursor && options.cursor.length <= MAX_CURSOR_LENGTH ? options.cursor : undefined;

  const [rows, total] = await Promise.all([
    storage.permissions.search({ limit: PERMISSIONS_PAGE_SIZE + 1, after, query }),
    storage.permissions.count({ query }),
  ]);
  const hasMore = rows.length > PERMISSIONS_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PERMISSIONS_PAGE_SIZE) : rows;
  const grants = await storage.permissions.countRoleGrants(page.map((permission) => permission.key));

  return {
    items: page.map((permission) => ({
      key: permission.key,
      name: permission.name,
      description: permission.description,
      grantedRoleCount: grants[permission.key] ?? 0,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.key : null,
    total,
  };
}

export interface FeaturesPage {
  items: FeatureView[];
  nextCursor: string | null;
  /** Total features matching the current search query (or all, if none). */
  total: number;
  /** Total organizations — the denominator of each feature's adoption. */
  totalOrganizations: number;
}

const FEATURES_PAGE_SIZE = 25;
const FEATURE_SAMPLE_SIZE = 3;

/**
 * Paginated, optionally search-filtered feature catalog for `/features` —
 * never loads the whole catalog nor walks every organization. Keyset paging
 * on `key`; per-feature adoption (how many organizations, plus a few of
 * them) comes from one grouped query for the page's keys
 * (`summarizeUsage`), and the sampled organization names from one batched
 * `findByIds` — three round-trips total regardless of catalog or tenant size.
 */
export async function getFeaturesPage(options?: { query?: string; cursor?: string }): Promise<FeaturesPage> {
  await requireSession();
  const storage = getStorage();
  const query = options?.query?.trim() || undefined;
  const after = options?.cursor && options.cursor.length <= MAX_CURSOR_LENGTH ? options.cursor : undefined;

  const [rows, total, totalOrganizations] = await Promise.all([
    storage.features.search({ limit: FEATURES_PAGE_SIZE + 1, after, query }),
    storage.features.count({ query }),
    storage.organizations.count(),
  ]);
  const hasMore = rows.length > FEATURES_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, FEATURES_PAGE_SIZE) : rows;

  const usage = await storage.features.summarizeUsage(
    page.map((definition) => definition.key),
    FEATURE_SAMPLE_SIZE,
  );
  const sampleIds = [...new Set(Object.values(usage).flatMap((entry) => entry.sampleOrganizationIds))];
  const nameById = new Map((await storage.organizations.findByIds(sampleIds)).map((org) => [org.id, org.name]));

  return {
    items: page.map((definition) => {
      const entry = usage[definition.key];
      return {
        key: definition.key,
        name: definition.name,
        description: definition.description,
        enabledCount: entry?.enabledCount ?? 0,
        sampleOrganizations: (entry?.sampleOrganizationIds ?? []).flatMap((id) => {
          const name = nameById.get(id);
          return name === undefined ? [] : [{ id, name }];
        }),
      };
    }),
    nextCursor: hasMore ? page[page.length - 1]!.key : null,
    total,
    totalOrganizations,
  };
}

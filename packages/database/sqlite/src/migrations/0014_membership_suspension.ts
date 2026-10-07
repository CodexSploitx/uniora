/**
 * Timed suspensions — same model as `@uniora/postgres`'s `0029_membership_suspension`: `blocked_until` is the end of a
 * block that lifts itself. A membership counts as blocked only while `status = 'blocked'` and `blocked_until` is null or
 * still in the future; the library reads an expired one as active everywhere, no job needed.
 */
export const MIGRATION_0014_MEMBERSHIP_SUSPENSION = `
alter table uniora_memberships add column blocked_until text;
`;

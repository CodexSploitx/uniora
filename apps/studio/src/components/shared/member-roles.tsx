"use client";

import { IconShieldLock, IconX } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { lookupHeldRoles } from "@/actions/lookup";
import { unassignMemberRole } from "@/actions/memberships";
import { useAction } from "@/components/shared/use-action";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/i18n/client";
import type { RoleRef } from "@/lib/types";

/** A role chip that stays one line however long the name is (full name on hover). */
export function RoleChip({ role, onRemove, removeLabel }: { role: RoleRef; onRemove?: () => void; removeLabel?: string }) {
  return (
    <Badge variant={role.isOwnerRole ? "primary-light" : "outline"} size="lg" className="max-w-56" title={role.name}>
      {role.isOwnerRole && <IconShieldLock />}
      <span className="truncate">{role.name}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          className="-mr-0.5 shrink-0 rounded-sm opacity-60 transition-opacity hover:opacity-100"
          onClick={onRemove}
        >
          <IconX />
        </button>
      )}
    </Badge>
  );
}

interface MemberRolesPopoverProps {
  organizationId: string;
  membershipId: string;
  memberLabel: string;
  /** How many roles are NOT shown inline (drives the "+N more" label). */
  hiddenCount: number;
  readOnly: boolean;
  /** Set when this member is the organization's last Owner: the Owner role cannot be removed from them. */
  protectOwnerRole: boolean;
}

/**
 * "+N more": every role a member holds, however many. The list is never sent
 * with the page — opening the popover (and each debounced keystroke) fetches a
 * page of at most 20, with the real total, so a member with 500 roles costs
 * the same as one with 5.
 */
export function MemberRolesPopover({ organizationId, membershipId, memberLabel, hiddenCount, readOnly, protectOwnerRole }: MemberRolesPopoverProps) {
  const { t } = useI18n();
  const { pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{ roles: RoleRef[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);

  const load = useCallback(
    async (q: string) => {
      const ticket = ++latest.current;
      setLoading(true);
      try {
        const result = await lookupHeldRoles({ organizationId, membershipId, query: q });
        if (ticket === latest.current) setState(result);
      } catch {
        if (ticket === latest.current) setState({ roles: [], total: 0 });
      } finally {
        if (ticket === latest.current) setLoading(false);
      }
    },
    [organizationId, membershipId],
  );

  useEffect(() => {
    if (!open) return;
    const timeout = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(timeout);
  }, [open, query, load]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setState(null);
        }
      }}
    >
      <PopoverTrigger
        render={<Button variant="ghost" size="xs" aria-label={t("members.allRolesAria", { member: memberLabel })} />}
      >
        {t("members.moreRoles", { count: hiddenCount })}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-2 p-2">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("roles.searchPlaceholder")}
          aria-label={t("roles.searchLabel")}
          maxLength={100}
        />
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto" aria-busy={loading}>
          {state && state.roles.length === 0 && (
            <li className="px-2 py-3 text-center text-xs text-muted-foreground">{t("roles.pickerEmpty")}</li>
          )}
          {!state && <li className="px-2 py-3 text-center text-xs text-muted-foreground">{t("roles.searching")}</li>}
          {state?.roles.map((role) => (
            <li key={role.id}>
              <RoleChip
                role={role}
                removeLabel={t("members.removeRoleAria", { role: role.name, member: memberLabel })}
                onRemove={
                  readOnly || pending || (role.isOwnerRole && protectOwnerRole)
                    ? undefined
                    : () =>
                        run(() => unassignMemberRole({ organizationId, membershipId, roleId: role.id }), {
                          success: t("members.removedRole", { role: role.name }),
                          onSuccess: () => void load(query),
                        })
                }
              />
            </li>
          ))}
        </ul>
        {state && state.total > state.roles.length && (
          <p className="px-1 text-xs text-muted-foreground">
            {t("members.showingRoles", { shown: state.roles.length, total: state.total })}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

"use client";

import { IconPlus, IconShieldLock } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { lookupRoles } from "@/actions/lookup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/i18n/client";
import type { RoleRef } from "@/lib/types";

interface RolePickerProps {
  organizationId: string;
  /** Only offer roles this membership does NOT hold yet (filtered on the server, so it holds for any number of roles). */
  notHeldBy?: string;
  onPick: (role: RoleRef) => void;
  /** Trigger label; defaults to "Role". */
  label?: string;
  disabled?: boolean;
  variant?: "ghost" | "outline";
}

/**
 * Typeahead role picker. An organization can hold thousands of roles, so the
 * list is never preloaded: opening it (and each debounced keystroke) asks the
 * server for at most 10 matching roles.
 */
export function RolePicker({ organizationId, notHeldBy, onPick, label, disabled, variant = "ghost" }: RolePickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [roles, setRoles] = useState<RoleRef[]>([]);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    if (!open) return;
    const ticket = ++latest.current;
    const timeout = setTimeout(async () => {
      setLoading(true);
      try {
        const found = await lookupRoles({ organizationId, query, notHeldBy });
        if (ticket === latest.current) setRoles(found);
      } catch {
        if (ticket === latest.current) setRoles([]);
      } finally {
        if (ticket === latest.current) setLoading(false);
      }
    }, query ? 250 : 0);
    return () => clearTimeout(timeout);
  }, [open, query, organizationId, notHeldBy]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger render={<Button variant={variant} size="xs" disabled={disabled} />}>
        <IconPlus /> {label ?? t("members.assignRole")}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-2 p-2">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("roles.searchPlaceholder")}
          aria-label={t("roles.searchLabel")}
          maxLength={100}
        />
        <ul className="flex max-h-56 flex-col overflow-y-auto" aria-busy={loading}>
          {roles.length === 0 && (
            <li className="px-2 py-3 text-center text-xs text-muted-foreground">
              {loading ? t("roles.searching") : t("roles.pickerEmpty")}
            </li>
          )}
          {roles.map((role) => (
            <li key={role.id}>
              <button
                type="button"
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => {
                  onPick(role);
                  setOpen(false);
                }}
              >
                {role.isOwnerRole && <IconShieldLock className="size-3.5 text-primary" />}
                <span className="truncate">{role.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

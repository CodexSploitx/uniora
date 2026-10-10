"use client";

import { IconAlertTriangle, IconChevronDown, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useI18n } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";
import { API_SCOPE_GROUPS, API_SCOPE_META, API_SCOPE_NAMES, API_SCOPE_PRESETS, needsActorAssert, scopesOfGroup, type ApiScopeGroup, type ApiScopeName } from "@/lib/api-scopes";

/**
 * Scopes by category, collapsed unless something in them is selected, with presets for the usual backends and a summary of what
 * is selected on top. A scope is shown by its name and one line of what it allows; the ones that act for a user are marked.
 */
export function ScopePicker({ value, onChange, idPrefix }: { value: ApiScopeName[]; onChange: (scopes: ApiScopeName[]) => void; idPrefix: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<Partial<Record<ApiScopeGroup, boolean>>>({});
  const set = (scopes: ApiScopeName[]) => onChange(API_SCOPE_NAMES.filter((scope) => scopes.includes(scope)));
  const toggle = (scope: ApiScopeName, on: boolean) => set(on ? [...value, scope] : value.filter((item) => item !== scope));

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("apiClients.presets")}>
        <span className="text-xs text-muted-foreground">{t("apiClients.presets")}</span>
        {API_SCOPE_PRESETS.map((preset) => (
          <Button key={preset.id} type="button" size="xs" variant="outline" title={preset.scopes.join(", ")} onClick={() => set([...preset.scopes])}>
            {t(`apiClients.preset_${preset.id}` as MessageKey)}
          </Button>
        ))}
        {value.length > 0 && (
          <Button type="button" size="xs" variant="ghost" onClick={() => set([])}>
            {t("apiClients.clearScopes")}
          </Button>
        )}
      </div>

      <div className="flex min-h-7 flex-wrap items-center gap-1.5 rounded-lg border bg-muted/30 p-1.5" aria-live="polite" data-testid="selected-scopes">
        {value.length === 0 ? (
          <span className="px-1 text-xs text-muted-foreground">{t("apiClients.noScopesSelected")}</span>
        ) : (
          value.map((scope) => (
            <Badge key={scope} variant={API_SCOPE_META[scope].sensitive ? "warning-light" : "outline"} className="gap-1 font-mono">
              {scope}
              <button type="button" className="-mr-0.5 rounded-sm opacity-70 hover:opacity-100" aria-label={t("apiClients.removeScope", { scope })} onClick={() => toggle(scope, false)}>
                <IconX className="size-3" />
              </button>
            </Badge>
          ))
        )}
      </div>

      {needsActorAssert(value) && (
        <p className="flex flex-wrap items-start gap-1.5 text-xs text-warning" role="status">
          <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{t("apiClients.needsActorAssert")}</span>
          <Button type="button" size="xs" variant="outline" onClick={() => set([...value, "actor:assert"])}>
            {t("apiClients.addActorAssert")}
          </Button>
        </p>
      )}

      <div className="grid gap-2">
        {API_SCOPE_GROUPS.map((group) => {
          const scopes = scopesOfGroup(group);
          const selected = scopes.filter((scope) => value.includes(scope)).length;
          const expanded = open[group] ?? selected > 0;
          const all = selected === scopes.length;
          return (
            <Collapsible key={group} open={expanded} onOpenChange={(next) => setOpen((current) => ({ ...current, [group]: next }))} className="rounded-lg border">
              <div className="flex items-center gap-2 px-3 py-2">
                {scopes.length > 1 && (
                  <Checkbox
                    aria-label={t("apiClients.selectGroup", { group: t(`apiGroup.${group}` as MessageKey) })}
                    checked={all}
                    indeterminate={selected > 0 && !all}
                    onCheckedChange={(next) => set(next ? [...new Set([...value, ...scopes])] : value.filter((scope) => !scopes.includes(scope)))}
                  />
                )}
                <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-label={t(`apiGroup.${group}` as MessageKey)}>
                  <span className="grid min-w-0 flex-1">
                    <span className="text-sm font-medium">{t(`apiGroup.${group}` as MessageKey)}</span>
                    <span className="truncate text-xs text-muted-foreground">{t(`apiGroup.${group}_hint` as MessageKey)}</span>
                  </span>
                  <Badge variant={selected > 0 ? "primary-light" : "outline"}>{t("apiClients.groupCount", { selected, total: scopes.length })}</Badge>
                  <IconChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent>
                <ul className="grid gap-2 border-t px-3 py-2.5">
                  {scopes.map((scope) => {
                    const id = `${idPrefix}-${scope}`;
                    return (
                      <li key={scope} className="flex items-start gap-2">
                        <Checkbox id={id} checked={value.includes(scope)} onCheckedChange={(next) => toggle(scope, next === true)} />
                        <label htmlFor={id} className="grid cursor-pointer gap-0.5">
                          <span className="flex items-center gap-1.5 font-mono text-xs">
                            {scope}
                            {API_SCOPE_META[scope].sensitive && <IconAlertTriangle className="size-3 text-warning" aria-label={t("apiClients.sensitive")} />}
                          </span>
                          <span className="text-xs text-muted-foreground">{t(`apiScope.${scope}` as MessageKey)}</span>
                          {scope === "actor:assert" && value.includes(scope) && <span className="text-xs text-warning">{t("apiClients.actorAssertWarning")}</span>}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}

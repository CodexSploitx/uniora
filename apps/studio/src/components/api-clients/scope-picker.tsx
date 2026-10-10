"use client";

import { IconAlertTriangle } from "@tabler/icons-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { useI18n } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";
import { API_SCOPE_NAMES, type ApiScopeName } from "@/lib/api-scopes";

/** Every scope is shown with what it ALLOWS in plain words; the ones that act on behalf of a user carry a warning. */
export function ScopePicker({ value, onChange, idPrefix }: { value: ApiScopeName[]; onChange: (scopes: ApiScopeName[]) => void; idPrefix: string }) {
  const { t } = useI18n();
  const scopes = API_SCOPE_NAMES;
  return (
    <div className="grid gap-2">
      {scopes.map((scope) => {
        const checked = value.includes(scope);
        const id = `${idPrefix}-${scope}`;
        return (
          <Field key={scope} orientation="horizontal" className="items-start">
            <Checkbox
              id={id}
              checked={checked}
              onCheckedChange={(next) => onChange(next ? [...value, scope] : value.filter((item) => item !== scope))}
            />
            <div className="grid gap-0.5">
              <FieldLabel htmlFor={id} className="font-mono text-xs">
                {scope}
              </FieldLabel>
              <FieldDescription>{t(`apiScope.${scope}` as MessageKey)}</FieldDescription>
              {scope === "actor:assert" && checked && (
                <p className="flex items-start gap-1.5 text-xs text-warning">
                  <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {t("apiClients.actorAssertWarning")}
                </p>
              )}
            </div>
          </Field>
        );
      })}
    </div>
  );
}

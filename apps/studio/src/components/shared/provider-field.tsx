"use client";

import { IconAlertTriangle, IconFingerprint } from "@tabler/icons-react";
import { useId, useState, type ChangeEvent } from "react";
import { KNOWN_PROVIDERS, matchKnownProvider } from "@/components/shared/provider-logos";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/client";

interface ProviderFieldProps {
  id: string;
  name: string;
  label: string;
  defaultValue?: string;
  autoFocus?: boolean;
}

/**
 * The "provider" half of an `Identity` is free text in `@uniora/core` (any
 * string an auth adapter — or a custom JWT setup — chooses to use), so this
 * stays a real text field, never a closed `<select>`. It adds two things on
 * top: a 2×2 grid of official logos for the adapters this install ships, to
 * click instead of typing, and a live, non-blocking notice when the typed
 * value doesn't match one of them — recognized adapters get their logo +
 * name, anything else is flagged as an unrecognized adapter that will be
 * treated as a custom identity provider (e.g. a custom JWT), per the exact
 * strings each adapter's `toIdentity()` produces (see `provider-logos.tsx`).
 *
 * Each logo chip has a fixed dark background, not the theme's own — Better
 * Auth's official brand color is white, which would vanish on a light card.
 */
export function ProviderField({ id, name, label, defaultValue, autoFocus }: ProviderFieldProps) {
  const { t } = useI18n();
  const [value, setValue] = useState(defaultValue ?? "");
  const groupId = useId();
  const recognized = value.trim() ? matchKnownProvider(value) : undefined;
  const unrecognized = value.trim().length > 0 && !recognized;
  const stillPrefilled = defaultValue !== undefined && value === defaultValue;

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    setValue(event.target.value);
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>

      <div className="grid grid-cols-2 gap-2" role="group" aria-labelledby={`${groupId}-picker`}>
        <span id={`${groupId}-picker`} className="sr-only">
          {t("provider.pickerLabel")}
        </span>
        {KNOWN_PROVIDERS.map((provider) => {
          const active = recognized?.key === provider.key;
          return (
            <button
              key={provider.key}
              type="button"
              aria-label={t("provider.selectAria", { provider: provider.label })}
              aria-pressed={active}
              onClick={() => setValue(provider.key)}
              className={
                "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm font-medium transition-colors " +
                (active ? "border-primary bg-primary/5 text-foreground" : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground")
              }
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-zinc-950">
                <provider.Logo className="size-4" />
              </span>
              {provider.label}
            </button>
          );
        })}
      </div>

      <Input
        id={id}
        name={name}
        value={value}
        onChange={onChange}
        placeholder="supabase"
        required
        maxLength={64}
        autoFocus={autoFocus}
        className="mt-1"
      />

      {stillPrefilled && <FieldDescription>{t("common.providerHint")}</FieldDescription>}
      {recognized && !stillPrefilled && (
        <FieldDescription className="flex items-center gap-1.5">
          <span className="flex size-4 items-center justify-center rounded-sm bg-zinc-950">
            <recognized.Logo className="size-2.5" />
          </span>
          {t("provider.recognized", { provider: recognized.label })}
        </FieldDescription>
      )}
      {unrecognized && (
        <FieldDescription className="flex items-start gap-1 text-warning-foreground">
          <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{t("provider.unrecognized", { value: value.trim() })}</span>
        </FieldDescription>
      )}
      {!value.trim() && (
        <FieldDescription className="flex items-center gap-1">
          <IconFingerprint className="size-3.5 shrink-0" />
          {t("provider.pickerHint")}
        </FieldDescription>
      )}
    </Field>
  );
}

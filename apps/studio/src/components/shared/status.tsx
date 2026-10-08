"use client";

import Link from "next/link";
import { Badge } from "@/components/reui/badge";
import { useI18n } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";

type Status = "active" | "suspended" | "blocked" | "archived";

const VARIANT = { active: "success-light", suspended: "warning-light", blocked: "destructive-light", archived: "secondary" } as const;

/** Colored state of a member (`active`, `suspended`, `blocked`) or an organization (`active`, `suspended`, `archived`). */
export function StatusBadge({ status }: { status: Status }) {
  const { t } = useI18n();
  return <Badge variant={VARIANT[status]}>{t(`status.${status}` as MessageKey)}</Badge>;
}

interface StatusFilterProps {
  /** Path the chips link to, with any other query params to keep; `status` and the pagination cursor are reset. */
  basePath: string;
  current?: string;
  values: readonly string[];
}

/** Server-driven filter chips: each one is a plain link, so the filtered page is shareable and needs no client state. */
export function StatusFilter({ basePath, current, values }: StatusFilterProps) {
  const { t } = useI18n();
  const [path = basePath, existing = ""] = basePath.split("?");
  const href = (value?: string) => {
    const params = new URLSearchParams(existing);
    params.delete("after");
    if (value) params.set("status", value);
    else params.delete("status");
    return params.size > 0 ? `${path}?${params.toString()}` : path;
  };
  return (
    <nav aria-label={t("status.filterLabel")} className="flex flex-wrap items-center gap-1.5">
      {[undefined, ...values].map((value) => {
        const active = value === current || (value === undefined && !current);
        return (
          <Link
            key={value ?? "all"}
            href={href(value)}
            aria-current={active ? "true" : undefined}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              active ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:border-primary/40 hover:text-foreground"
            }`}
          >
            {value ? t(`status.${value}` as MessageKey) : t("status.all")}
          </Link>
        );
      })}
    </nav>
  );
}

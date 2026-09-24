"use client";

import { IconArrowRight, IconToggleRight } from "@tabler/icons-react";
import Link from "next/link";
import { useOptimistic } from "react";
import { setOrganizationFeature } from "@/actions/features";
import { ListSearch } from "@/components/shared/list-search";
import { useAction } from "@/components/shared/use-action";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/client";
import { rich } from "@/i18n/rich";
import type { OrgFeatureToggle } from "@/lib/types";

interface OrgFeaturesListProps {
  organizationId: string;
  /** `/organizations/<id>` */
  orgPath: string;
  features: OrgFeatureToggle[];
  total: number;
  query: string;
  enabledOnly: boolean;
  nextCursor: string | null;
  readOnly: boolean;
}

function featuresHref(orgPath: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams({ tab: "features" });
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  return `${orgPath}?${search.toString()}`;
}

/**
 * The feature catalog as seen by ONE organization: a bounded, searchable page
 * with this organization's on/off state per row (`enabledKeys` for the page's
 * keys only) — never every catalog feature at once.
 */
export function OrgFeaturesList({ organizationId, orgPath, features, total, query, enabledOnly, nextCursor, readOnly }: OrgFeaturesListProps) {
  const { pending, run } = useAction();
  const { t } = useI18n();
  const [optimistic, setOptimistic] = useOptimistic(features, (current, change: { key: string; enabled: boolean }) =>
    current.map((feature) => (feature.key === change.key ? { ...feature, enabled: change.enabled } : feature)),
  );

  if (total === 0 && !query && !enabledOnly) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconToggleRight />
          </EmptyMedia>
          <EmptyTitle>{t("features.noneTitle")}</EmptyTitle>
          <EmptyDescription>
            {rich(t("features.noneDescription"), {
              link: (
                <Link href="/features" className="underline underline-offset-4">
                  {t("features.catalogLink")}
                </Link>
              ),
            })}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const show = enabledOnly ? "enabled" : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListSearch
          basePath={featuresHref(orgPath, { show })}
          initialQuery={query}
          placeholderKey="feats.searchPlaceholder"
          labelKey="feats.searchLabel"
          clearKey="feats.clearSearch"
        />
        <div className="flex items-center gap-2 text-xs">
          <Link
            href={featuresHref(orgPath, { q: query })}
            className={"rounded-md px-2 py-1 " + (!enabledOnly ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}
          >
            {t("features.filterAll")}
          </Link>
          <Link
            href={featuresHref(orgPath, { q: query, show: "enabled" })}
            className={"rounded-md px-2 py-1 " + (enabledOnly ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}
          >
            {t("features.filterEnabled")}
          </Link>
          <span className="text-muted-foreground">{t("feats.resultsCount", { count: total })}</span>
        </div>
      </div>

      {optimistic.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>{query ? t("feats.noMatchesTitle", { query }) : t("features.noEnabled")}</EmptyTitle>
            <EmptyDescription>{t("feats.noMatchesDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
          {optimistic.map((feature) => (
            <li key={feature.key} className="flex items-center justify-between gap-4 p-4">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">{feature.name}</span>
                <code className="text-xs text-muted-foreground">{feature.key}</code>
                {feature.description && <span className="text-xs text-muted-foreground">{feature.description}</span>}
              </div>
              <Switch
                checked={feature.enabled}
                disabled={readOnly || pending}
                aria-label={t("features.toggleAria", { feature: feature.name })}
                onCheckedChange={(checked) =>
                  run(() => setOrganizationFeature({ organizationId, key: feature.key, enabled: checked }), {
                    success: checked ? t("features.enabledToast", { feature: feature.name }) : t("features.disabledToast", { feature: feature.name }),
                    before: () => setOptimistic({ key: feature.key, enabled: checked }),
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}

      {nextCursor && (
        <div className="flex justify-center">
          <Button variant="outline" render={<Link href={featuresHref(orgPath, { q: query, show, after: nextCursor })} />}>
            {t("feats.loadMore")} <IconArrowRight />
          </Button>
        </div>
      )}
    </div>
  );
}

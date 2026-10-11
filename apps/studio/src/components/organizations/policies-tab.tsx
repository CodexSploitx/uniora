"use client";

import { IconArrowRight, IconShieldCheck } from "@tabler/icons-react";
import Link from "next/link";
import { ListSearch } from "@/components/shared/list-search";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { useI18n } from "@/i18n/client";
import { formatDate } from "@/lib/format";
import type { PolicyDetailPage } from "@/lib/queries";
import type { PolicyRow } from "@/lib/types";

export interface PoliciesTabProps {
  /** `/organizations/<id>`: every link below is built from it. */
  orgPath: string;
  policies: PolicyRow[];
  total: number;
  query: string;
  status: PolicyRow["status"] | undefined;
  nextCursor: string | null;
  selectedPolicyId: string | null;
  detail: PolicyDetailPage | null;
}

const STATUSES = ["draft", "active", "disabled", "retired"] as const;
const STATUS_VARIANT: Record<PolicyRow["status"], "success" | "outline" | "secondary" | "destructive"> = {
  active: "success",
  draft: "outline",
  disabled: "secondary",
  retired: "destructive",
};

function policiesHref(orgPath: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams({ tab: "policies" });
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  return `${orgPath}?${search.toString()}`;
}

/**
 * Policies of one organization, master/detail like Teams and Roles, READ ONLY: the left list pages through policies, the right
 * panel shows ONE policy with its definition and its revision history. A policy only restricts what roles allow; it never grants.
 * Policies are written through the policy service of your application (so the changes are checked against your own roles).
 */
export function PoliciesTab(props: PoliciesTabProps) {
  const { orgPath, policies, total, query, status, nextCursor, selectedPolicyId, detail } = props;
  const { t } = useI18n();

  if (total === 0 && !query && !status) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconShieldCheck />
          </EmptyMedia>
          <EmptyTitle>{t("policies.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("policies.emptyDescription")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <section className="flex min-w-0 flex-col gap-3 lg:col-span-2" aria-label={t("policies.listAria")}>
        <ListSearch
          basePath={policiesHref(orgPath, { policy: selectedPolicyId, pstatus: status })}
          initialQuery={query}
          placeholderKey="policies.searchPlaceholder"
          labelKey="policies.searchLabel"
          clearKey="policies.clearSearch"
        />
        <nav aria-label={t("policies.statusFilterAria")} className="flex flex-wrap items-center gap-1">
          {[undefined, ...STATUSES].map((value) => (
            <Link
              key={value ?? "all"}
              href={policiesHref(orgPath, { policy: selectedPolicyId, q: query, pstatus: value })}
              aria-current={value === status ? "true" : undefined}
              className={
                "rounded-full border px-2.5 py-0.5 text-xs " +
                (value === status ? "border-primary/40 bg-primary/5 text-primary" : "text-muted-foreground hover:text-foreground")
              }
            >
              {value ? t(`policies.status.${value}`) : t("policies.statusAll")}
            </Link>
          ))}
        </nav>
        <span className="text-xs text-muted-foreground">{t("policies.resultsCount", { count: total })}</span>

        {policies.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>{t("policies.noMatchesTitle")}</EmptyTitle>
              <EmptyDescription>{t("policies.noMatchesDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex max-h-[28rem] flex-col divide-y overflow-y-auto rounded-xl border bg-card lg:max-h-[calc(100vh-20rem)]">
            {policies.map((policy) => (
              <li key={policy.id}>
                <Link
                  href={policiesHref(orgPath, { policy: policy.id, q: query, pstatus: status })}
                  aria-current={policy.id === selectedPolicyId ? "true" : undefined}
                  className={"flex flex-col gap-1 px-4 py-3 transition-colors " + (policy.id === selectedPolicyId ? "bg-primary/5" : "hover:bg-muted/50")}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <span className="truncate" title={policy.name}>{policy.name}</span>
                    <Badge variant={STATUS_VARIANT[policy.status]} size="sm">{t(`policies.status.${policy.status}`)}</Badge>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                    <code>{policy.key}</code>
                    <span aria-hidden>·</span>
                    <span>{t(`policies.kind.${policy.kind}`)}</span>
                    <span aria-hidden>·</span>
                    <span>{t(`policies.effect.${policy.effect}`)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {nextCursor && (
          <Button variant="outline" render={<Link href={policiesHref(orgPath, { policy: selectedPolicyId, q: query, pstatus: status, after: nextCursor })} />}>
            {t("policies.loadMore")} <IconArrowRight />
          </Button>
        )}
      </section>

      <section className="min-w-0 lg:sticky lg:top-20 lg:col-span-3 lg:self-start" aria-label={t("policies.detailAria")}>
        {detail ? (
          <PolicyDetail orgPath={orgPath} detail={detail} />
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>{t("policies.selectTitle")}</EmptyTitle>
              <EmptyDescription>{t("policies.selectDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
    </div>
  );
}

function PolicyDetail({ orgPath, detail }: { orgPath: string; detail: PolicyDetailPage }) {
  const { t, locale } = useI18n();
  const { policy, revisions, revisionsNextBefore } = detail;
  const who = (identity: { provider: string; subject: string }) => `${identity.provider}:${identity.subject}`;

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-1.5 font-heading text-base font-semibold">
          <span className="truncate">{policy.name}</span>
          <Badge variant={STATUS_VARIANT[policy.status]} size="sm">{t(`policies.status.${policy.status}`)}</Badge>
        </h3>
        <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <code>{policy.key}</code>
          <span aria-hidden>·</span>
          <span>{t(`policies.kind.${policy.kind}`)}</span>
          <span aria-hidden>·</span>
          <span>{t(`policies.effect.${policy.effect}`)}</span>
          <span aria-hidden>·</span>
          <span>{t("policies.revisionLabel", { revision: policy.revision })}</span>
        </div>
        {policy.description && <p className="text-sm">{policy.description}</p>}
      </div>

      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex flex-col">
          <dt className="text-muted-foreground">{t("policies.createdBy")}</dt>
          <dd className="truncate" title={who(policy.createdBy)}>{who(policy.createdBy)} · {formatDate(policy.createdAt, locale)}</dd>
        </div>
        {policy.activatedAt && (
          <div className="flex flex-col">
            <dt className="text-muted-foreground">{t("policies.firstActive")}</dt>
            <dd>{formatDate(policy.activatedAt, locale)}</dd>
          </div>
        )}
        {policy.statusChange && (
          <div className="flex flex-col sm:col-span-2">
            <dt className="text-muted-foreground">{t("policies.lastStatusChange")}</dt>
            <dd className="truncate">
              {who(policy.statusChange.by)} · {formatDate(policy.statusChange.at, locale)}
              {policy.statusChange.reason ? ` · ${policy.statusChange.reason}` : ""}
            </dd>
          </div>
        )}
        <div className="flex flex-col sm:col-span-2">
          <dt className="text-muted-foreground">{t("policies.hash")}</dt>
          <dd><code className="break-all">{policy.hash}</code></dd>
        </div>
      </dl>

      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-medium">{t("policies.definition")}</h4>
        <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed" tabIndex={0}>
          {JSON.stringify(policy.definition, null, 2)}
        </pre>
      </div>

      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-medium">{t("policies.history")}</h4>
        <ul className="flex flex-col divide-y rounded-lg border text-xs">
          {revisions.map((revision) => (
            <li key={revision.revision} className="flex flex-col gap-0.5 px-3 py-2">
              <span className="flex flex-wrap items-center gap-x-1.5">
                <span className="font-medium">{t("policies.revisionLabel", { revision: revision.revision })}</span>
                <span aria-hidden>·</span>
                <span className="text-muted-foreground">{who(revision.createdBy)}</span>
                <span aria-hidden>·</span>
                <span className="text-muted-foreground">{formatDate(revision.createdAt, locale)}</span>
                <code className="ml-auto text-muted-foreground">{revision.hash}</code>
              </span>
              {revision.note && <span className="text-muted-foreground">{revision.note}</span>}
            </li>
          ))}
        </ul>
        {revisionsNextBefore !== null && (
          <Button variant="outline" size="sm" render={<Link href={policiesHref(orgPath, { policy: policy.id, rbefore: String(revisionsNextBefore) })} />}>
            {t("policies.olderRevisions")} <IconArrowRight />
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{t("policies.readOnlyNote")}</p>
    </div>
  );
}

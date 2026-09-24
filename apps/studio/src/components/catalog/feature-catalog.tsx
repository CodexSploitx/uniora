"use client";

import { IconArrowRight, IconPlus, IconToggleRight, IconTrash } from "@tabler/icons-react";
import Link from "next/link";
import { useState } from "react";
import { registerFeature, unregisterFeature } from "@/actions/features";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ListSearch } from "@/components/shared/list-search";
import { useAction } from "@/components/shared/use-action";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/client";
import { rich } from "@/i18n/rich";
import type { FeatureView } from "@/lib/types";

interface FeatureCatalogProps {
  features: FeatureView[];
  total: number;
  totalOrganizations: number;
  query: string;
  nextHref: string | null;
  readOnly: boolean;
}

export function FeatureCatalog({ features, total, totalOrganizations, query, nextHref, readOnly }: FeatureCatalogProps) {
  const { pending, run } = useAction();
  const { t } = useI18n();

  if (total === 0 && !query) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconToggleRight />
          </EmptyMedia>
          <EmptyTitle>{t("feats.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{rich(t("feats.emptyDescription"), { example: <code>advanced_reports</code> })}</EmptyDescription>
        </EmptyHeader>
        {!readOnly && (
          <EmptyContent>
            <RegisterFeatureDialog />
          </EmptyContent>
        )}
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ListSearch
          basePath="/features"
          initialQuery={query}
          placeholderKey="feats.searchPlaceholder"
          labelKey="feats.searchLabel"
          clearKey="feats.clearSearch"
        />
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{t("feats.resultsCount", { count: total })}</span>
          {!readOnly && <RegisterFeatureDialog />}
        </div>
      </div>

      {features.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconToggleRight />
            </EmptyMedia>
            <EmptyTitle>{t("feats.noMatchesTitle", { query })}</EmptyTitle>
            <EmptyDescription>{t("feats.noMatchesDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[28%]">{t("feats.feature")}</TableHead>
                <TableHead className="w-[30%]">{t("feats.descriptionColumn")}</TableHead>
                <TableHead>{t("feats.adoption")}</TableHead>
                {!readOnly && <TableHead className="w-16 text-right">&nbsp;</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {features.map((feature) => (
                <FeatureRow
                  key={feature.key}
                  feature={feature}
                  totalOrganizations={totalOrganizations}
                  readOnly={readOnly}
                  pending={pending}
                  onUnregister={() => run(() => unregisterFeature({ key: feature.key }), { success: t("feats.unregistered") })}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {nextHref && (
        <div className="flex justify-center">
          <Button variant="outline" render={<Link href={nextHref} />}>
            {t("feats.loadMore")} <IconArrowRight />
          </Button>
        </div>
      )}
    </div>
  );
}

interface FeatureRowProps {
  feature: FeatureView;
  totalOrganizations: number;
  readOnly: boolean;
  pending: boolean;
  onUnregister: () => void;
}

function FeatureRow({ feature, totalOrganizations, readOnly, pending, onUnregister }: FeatureRowProps) {
  const { t } = useI18n();
  const percent = totalOrganizations > 0 ? Math.min(100, Math.round((feature.enabledCount / totalOrganizations) * 100)) : 0;
  const remaining = feature.enabledCount - feature.sampleOrganizations.length;

  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{feature.name}</span>
          <code className="text-xs text-muted-foreground">{feature.key}</code>
        </div>
      </TableCell>
      <TableCell className="max-w-72 align-top whitespace-normal text-muted-foreground">{feature.description ?? "—"}</TableCell>
      <TableCell className="align-top">
        {feature.enabledCount === 0 ? (
          <Badge variant="outline">{t("feats.notEnabled")}</Badge>
        ) : (
          <div className="flex min-w-48 flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="font-medium tabular-nums">
                {t("feats.adoptionOf", { count: feature.enabledCount, total: totalOrganizations })}
              </span>
              <span className="text-muted-foreground tabular-nums">{percent}%</span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t("feats.adoptionAria", { count: feature.enabledCount, total: totalOrganizations })}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(percent, 2)}%` }} />
            </div>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
              {feature.sampleOrganizations.map((organization, index) => (
                <span key={organization.id}>
                  <Link href={`/organizations/${organization.id}`} className="hover:text-primary hover:underline">
                    {organization.name}
                  </Link>
                  {index < feature.sampleOrganizations.length - 1 || remaining > 0 ? "," : ""}
                </span>
              ))}
              {remaining > 0 && <span>{t("feats.moreOrgs", { count: remaining })}</span>}
            </div>
          </div>
        )}
      </TableCell>
      {!readOnly && (
        <TableCell className="text-right align-top">
          <ConfirmDialog
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label={t("feats.unregisterAria", { key: feature.key })} disabled={pending}>
                <IconTrash />
              </Button>
            }
            title={t("feats.unregisterTitle", { name: feature.name })}
            description={
              feature.enabledCount > 0
                ? t("feats.unregisterInUse", { count: feature.enabledCount })
                : t("feats.unregisterFree")
            }
            confirmLabel={t("feats.unregisterConfirm")}
            pending={pending}
            onConfirm={onUnregister}
          />
        </TableCell>
      )}
    </TableRow>
  );
}

function RegisterFeatureDialog() {
  const { pending, run } = useAction();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <IconPlus /> {t("feats.register")}
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            run(
              () =>
                registerFeature({
                  name: String(form.get("name") ?? ""),
                  key: String(form.get("key") ?? ""),
                  description: String(form.get("description") ?? ""),
                }),
              { success: t("feats.registered"), onSuccess: () => setOpen(false) },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("feats.register")}</DialogTitle>
            <DialogDescription>{t("feats.registerDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="feat-name">{t("feats.name")}</FieldLabel>
              <Input id="feat-name" name="name" placeholder="Advanced reports" required maxLength={100} autoFocus />
            </Field>
            <Field>
              <FieldLabel htmlFor="feat-key">{t("feats.keyOptional")}</FieldLabel>
              <Input id="feat-key" name="key" placeholder="advanced_reports" maxLength={64} />
              <FieldDescription>{t("feats.keyHint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="feat-desc">{t("feats.descriptionOptional")}</FieldLabel>
              <Input id="feat-desc" name="description" maxLength={500} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? t("feats.saving") : t("feats.registerConfirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

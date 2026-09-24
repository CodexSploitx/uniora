import { FeatureCatalog } from "@/components/catalog/feature-catalog";
import { PageHeader } from "@/components/shell/page-header";
import { getT } from "@/i18n/server";
import { getFeaturesPage } from "@/lib/queries";
import { isReadOnly } from "@/lib/session";

export default async function FeaturesPage(props: PageProps<"/features">) {
  const searchParams = await props.searchParams;
  const q = Array.isArray(searchParams.q) ? searchParams.q[0] : searchParams.q;
  const after = Array.isArray(searchParams.after) ? searchParams.after[0] : searchParams.after;

  const { items, nextCursor, total, totalOrganizations } = await getFeaturesPage({ query: q, cursor: after });
  const { t } = await getT();

  let nextHref: string | null = null;
  if (nextCursor) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("after", nextCursor);
    nextHref = `/features?${params.toString()}`;
  }

  return (
    <>
      <PageHeader title={t("feats.title")} description={t("feats.description")} />
      <FeatureCatalog
        features={items}
        total={total}
        totalOrganizations={totalOrganizations}
        query={q ?? ""}
        nextHref={nextHref}
        readOnly={isReadOnly()}
      />
    </>
  );
}

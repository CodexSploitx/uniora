import { PermissionCatalog } from "@/components/catalog/permission-catalog";
import { PageHeader } from "@/components/shell/page-header";
import { getT } from "@/i18n/server";
import { getPermissionsPage } from "@/lib/queries";
import { isReadOnly } from "@/lib/session";

export default async function PermissionsPage(props: PageProps<"/permissions">) {
  const searchParams = await props.searchParams;
  const q = Array.isArray(searchParams.q) ? searchParams.q[0] : searchParams.q;
  const after = Array.isArray(searchParams.after) ? searchParams.after[0] : searchParams.after;

  const { items, nextCursor, total } = await getPermissionsPage({ query: q, cursor: after });
  const { t } = await getT();

  let nextHref: string | null = null;
  if (nextCursor) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("after", nextCursor);
    nextHref = `/permissions?${params.toString()}`;
  }

  return (
    <>
      <PageHeader title={t("perms.title")} description={t("perms.description")} />
      <PermissionCatalog permissions={items} total={total} query={q ?? ""} nextHref={nextHref} readOnly={isReadOnly()} />
    </>
  );
}

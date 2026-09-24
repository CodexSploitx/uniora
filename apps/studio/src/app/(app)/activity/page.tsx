import { IconArrowRight } from "@tabler/icons-react";
import Link from "next/link";
import { ActivityFeed } from "@/components/shared/activity-feed";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { getT } from "@/i18n/server";
import { getActivityPage } from "@/lib/queries";

export default async function ActivityPage(props: PageProps<"/activity">) {
  const searchParams = await props.searchParams;
  const cursor = Array.isArray(searchParams.before) ? searchParams.before[0] : searchParams.before;
  const { items, nextCursor } = await getActivityPage(cursor);
  const { t } = await getT();

  return (
    <>
      <PageHeader title={t("activity.pageTitle")} description={t("activity.pageDescription")} crumbs={[{ label: t("nav.activity") }]} />

      <div className="rounded-xl border bg-card p-5">
        <ActivityFeed items={items} showOrganization />
      </div>

      {nextCursor && (
        <div className="flex justify-center">
          <Button variant="outline" render={<Link href={`/activity?before=${encodeURIComponent(nextCursor)}`} />}>
            {t("activity.loadOlder")} <IconArrowRight />
          </Button>
        </div>
      )}
    </>
  );
}

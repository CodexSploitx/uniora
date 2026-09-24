import { IconHistory } from "@tabler/icons-react";
import Link from "next/link";
import {
  Timeline,
  TimelineContent,
  TimelineDate,
  TimelineHeader,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
  TimelineTitle,
} from "@/components/reui/timeline";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { getT } from "@/i18n/server";
import { describeActivity, formatDate, timeAgo } from "@/lib/format";
import type { ActivityItem } from "@/lib/types";

const TONE_CLASS = {
  success: "border-success!",
  info: "border-info!",
  warning: "border-warning!",
  destructive: "border-destructive!",
} as const;

export async function ActivityFeed({ items, showOrganization = false }: { items: ActivityItem[]; showOrganization?: boolean }) {
  const { t, locale } = await getT();
  if (items.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconHistory />
          </EmptyMedia>
          <EmptyTitle>{t("activity.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("activity.emptyDescription")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Timeline value={items.length}>
      {items.map((item, index) => {
        const { title, detail, tone } = describeActivity(item, t);
        return (
          <TimelineItem key={item.id} step={index + 1}>
            <TimelineHeader>
              <TimelineSeparator />
              <TimelineIndicator className={TONE_CLASS[tone]} />
              <TimelineDate dateTime={item.createdAt} title={formatDate(item.createdAt, locale)}>
                {timeAgo(item.createdAt, locale, t)}
              </TimelineDate>
              <TimelineTitle>{title}</TimelineTitle>
            </TimelineHeader>
            <TimelineContent>
              {detail && <span className="text-foreground">{detail}</span>}
              {showOrganization && (
                <>
                  {detail ? " · " : ""}
                  <Link href={`/organizations/${item.organizationId}`} className="underline-offset-4 hover:underline">
                    {item.organizationName}
                  </Link>
                </>
              )}
            </TimelineContent>
          </TimelineItem>
        );
      })}
    </Timeline>
  );
}

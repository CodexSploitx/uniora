import { IconArrowRight, IconPlugConnected } from "@tabler/icons-react";
import Link from "next/link";
import { ClientCard } from "@/components/api-clients/client-card";
import { ClientFormDialog } from "@/components/api-clients/client-form-dialog";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { getT } from "@/i18n/server";
import { getApiClientsPage } from "@/lib/queries";
import { isReadOnly } from "@/lib/session";

export default async function ApiClientsPage(props: PageProps<"/api-clients">) {
  const searchParams = await props.searchParams;
  const after = Array.isArray(searchParams.after) ? searchParams.after[0] : searchParams.after;
  const page = await getApiClientsPage({ cursor: after });
  const { t } = await getT();
  const readOnly = isReadOnly();

  return (
    <>
      <PageHeader title={t("apiClients.title")} description={t("apiClients.description")} actions={page.available && !readOnly ? <ClientFormDialog /> : undefined} />

      {!page.available ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconPlugConnected />
            </EmptyMedia>
            <EmptyTitle>{t("apiClients.unavailableTitle")}</EmptyTitle>
            <EmptyDescription>{t("apiClients.unavailableDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : page.clients.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconPlugConnected />
            </EmptyMedia>
            <EmptyTitle>{t("apiClients.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("apiClients.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid min-w-0 gap-4">
          {page.clients.map((client) => (
            <ClientCard key={client.id} client={client} readOnly={readOnly} />
          ))}
          {page.nextCursor && (
            <div className="flex justify-center">
              <Button variant="outline" render={<Link href={`/api-clients?${new URLSearchParams({ after: page.nextCursor }).toString()}`} />}>
                {t("members.loadMore")} <IconArrowRight />
              </Button>
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("apiClients.secretsNote")}</p>
    </>
  );
}

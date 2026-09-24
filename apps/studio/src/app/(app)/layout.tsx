import { cookies } from "next/headers";
import { IconDatabaseOff } from "@tabler/icons-react";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { LanguageSwitcher } from "@/components/shared/language-switcher";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { getT } from "@/i18n/server";
import { rich } from "@/i18n/rich";
import { Badge } from "@/components/reui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/reui/alert";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { isReadOnly, requireSession } from "@/lib/session";
import { getSidebarOrganizations, isSchemaReady } from "@/lib/queries";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  const { t } = await getT();
  const defaultOpen = (await cookies()).get("sidebar_state")?.value !== "false";
  const ready = await isSchemaReady();
  const sidebarOrganizations = ready ? await getSidebarOrganizations() : { items: [], total: 0 };
  const readOnly = isReadOnly();

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar
        organizations={sidebarOrganizations.items}
        organizationsTotal={sidebarOrganizations.total}
        readOnly={readOnly}
      />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mx-1 h-5" />
          <span className="text-sm text-muted-foreground">{t("nav.localAdmin")}</span>
          <div className="ml-auto flex items-center gap-2">
            {readOnly && <Badge variant="warning-light">{t("common.readOnly")}</Badge>}
            <Badge variant="success-light">PostgreSQL</Badge>
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </header>
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-8">
          {ready ? (
            children
          ) : (
            <Alert variant="warning">
              <IconDatabaseOff />
              <AlertTitle>{t("setup.title")}</AlertTitle>
              <AlertDescription>{rich(t("setup.description"), { command: <code>npx uniora migrate</code> })}</AlertDescription>
            </Alert>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

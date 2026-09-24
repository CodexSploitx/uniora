import { UnioraProvider } from "@uniora/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/reui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { FeatureCheck } from "@/components/playground/feature-check";
import { PermissionCheck } from "@/components/playground/permission-check";
import { RoleSwitcher } from "@/components/playground/role-switcher";
import { computeDemoSnapshot, isDemoRole, type DemoRoleKey } from "@/lib/demo-storage";

const ROLE_LABELS: Record<DemoRoleKey, string> = {
  owner: "Owner",
  sales: "Sales",
  viewer: "Viewer",
};

const ROLE_INITIALS: Record<DemoRoleKey, string> = {
  owner: "AO",
  sales: "SS",
  viewer: "VV",
};

export default async function Home(props: PageProps<"/">) {
  const searchParams = await props.searchParams;
  const roleParam = Array.isArray(searchParams.role) ? searchParams.role[0] : searchParams.role;
  const role: DemoRoleKey = isDemoRole(roleParam) ? roleParam : "sales";

  // The only authorization-sensitive step on this page: computed server-side,
  // against the real AuthorizationEngine — everything below the
  // UnioraProvider only ever reads the resulting snapshot.
  const snapshot = await computeDemoSnapshot(role);

  return (
    <UnioraProvider snapshot={snapshot}>
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-12">
        <header className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Avatar size="lg">
              <AvatarFallback>{ROLE_INITIALS[role]}</AvatarFallback>
            </Avatar>
            <div>
              <h1 className="font-heading text-xl font-medium">@uniora/react playground</h1>
              <p className="text-sm text-muted-foreground">
                Viewing Acme Motors as <strong className="text-foreground">{ROLE_LABELS[role]}</strong>
              </p>
            </div>
          </div>
          <RoleSwitcher activeRole={role} />
        </header>

        <Alert variant="info">
          <AlertTitle>This snapshot was computed on the server</AlertTitle>
          <AlertDescription>
            Switching roles reloads the page and recomputes an <code>AuthorizationSnapshot</code> for that
            identity via <code>computeAuthorizationSnapshot()</code>. The cards below only ever read that
            snapshot through <code>@uniora/react</code> — they never talk to a database.
          </AlertDescription>
        </Alert>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Permissions</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <PermissionCheck
              role={role}
              permission="vehicles.create"
              actionLabel="Create vehicle"
              description="Only the Owner role can create vehicles in this demo."
            />
            <PermissionCheck
              role={role}
              permission="vehicles.delete"
              actionLabel="Delete vehicle"
              description="Only the Owner role can delete vehicles in this demo."
            />
            <PermissionCheck
              role={role}
              permission="leads.create"
              actionLabel="Create lead"
              description="Granted to Owner and Sales."
            />
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Features</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <FeatureCheck
              feature="advanced_reports"
              label="Advanced Reports"
              description="Enabled for Acme Motors — every role sees it."
            />
            <FeatureCheck
              feature="ai_assistant"
              label="AI Assistant"
              description="Registered but left disabled for this organization."
            />
          </div>
        </section>
      </main>
    </UnioraProvider>
  );
}

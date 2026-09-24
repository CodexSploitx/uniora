import Link from "next/link";
import { cn } from "cn";
import { buttonVariants } from "@/components/ui/button";
import type { DemoRoleKey } from "@/lib/demo-storage";

const ROLE_LABELS: Record<DemoRoleKey, string> = {
  owner: "Owner",
  sales: "Sales",
  viewer: "Viewer",
};

const ROLE_ORDER: DemoRoleKey[] = ["owner", "sales", "viewer"];

interface RoleSwitcherProps {
  activeRole: DemoRoleKey;
}

/**
 * Plain links, not client-side state: switching roles navigates to a new
 * `?role=` search param, which re-runs the server-side snapshot
 * computation for that identity — the same round trip a real app makes.
 */
export function RoleSwitcher({ activeRole }: RoleSwitcherProps) {
  return (
    <div className="inline-flex gap-1 rounded-lg border border-border bg-muted/40 p-1">
      {ROLE_ORDER.map((role) => (
        <Link
          key={role}
          href={role === "sales" ? "/" : `/?role=${role}`}
          className={cn(buttonVariants({ variant: role === activeRole ? "default" : "ghost", size: "sm" }))}
        >
          {ROLE_LABELS[role]}
        </Link>
      ))}
    </div>
  );
}

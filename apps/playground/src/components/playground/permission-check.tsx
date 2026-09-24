"use client";

import { useState, useTransition } from "react";
import { IconCheck, IconLock, IconServer } from "@tabler/icons-react";
import { Can, useCan } from "@uniora/react";
import { simulateProtectedAction } from "@/app/actions";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { DemoRoleKey } from "@/lib/demo-storage";

interface PermissionCheckProps {
  role: DemoRoleKey;
  permission: string;
  actionLabel: string;
  description: string;
}

/**
 * One card per permission: `useCan` drives the status badge, `<Can>`
 * drives which button actually renders. Both read the same
 * AuthorizationSnapshot the server computed for the active demo role —
 * this component never decides authorization itself.
 *
 * Clicking the granted button calls a real Server Action
 * (`simulateProtectedAction`, `@uniora/next`'s `assertCan`) that
 * independently re-authorizes on the server — proving `<Can>` hiding the
 * button is UX only, not the actual security boundary.
 */
export function PermissionCheck({ role, permission, actionLabel, description }: PermissionCheckProps) {
  const granted = useCan(permission);
  const [isPending, startTransition] = useTransition();
  const [serverResult, setServerResult] = useState<boolean | null>(null);

  function runAction() {
    startTransition(async () => {
      const result = await simulateProtectedAction(role, permission);
      setServerResult(result.granted);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <code className="font-mono text-sm">{permission}</code>
          <Badge variant={granted ? "success-light" : "outline"}>{granted ? "Granted" : "Denied"}</Badge>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {serverResult !== null && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <IconServer className="size-3.5" />
            Server {serverResult ? "independently authorized" : "independently denied"} this via{" "}
            <code>assertCan</code>.
          </p>
        )}
      </CardContent>
      <CardFooter>
        <Can
          permission={permission}
          fallback={
            <Button variant="outline" size="sm" disabled>
              <IconLock /> {actionLabel}
            </Button>
          }
        >
          <Button size="sm" disabled={isPending} onClick={runAction}>
            <IconCheck /> {actionLabel}
          </Button>
        </Can>
      </CardFooter>
    </Card>
  );
}

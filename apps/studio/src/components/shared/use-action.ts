"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { useI18n } from "@/i18n/client";
import type { ActionResult } from "@/actions/mutate";

/** Runs a Server Action, shows a toast with the outcome and exposes a pending flag. */
export function useAction() {
  const [pending, startTransition] = useTransition();
  const { t } = useI18n();

  function run<T>(
    action: () => Promise<ActionResult<T>>,
    options: { success?: string; before?: () => void; onSuccess?: (result: Extract<ActionResult<T>, { ok: true }>) => void } = {},
  ) {
    startTransition(async () => {
      options.before?.();
      try {
        const result = await action();
        if (result.ok) {
          toast.success(options.success ?? "OK");
          options.onSuccess?.(result);
        } else {
          toast.error(result.error);
        }
      } catch {
        toast.error(t("errors.requestFailed"));
      }
    });
  }

  return { pending, run };
}

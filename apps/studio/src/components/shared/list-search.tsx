"use client";

import { IconSearch, IconX } from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { useI18n } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";

interface ListSearchProps {
  /**
   * Page path the search param is written to, e.g. `/organizations`. May carry
   * other query params (`/organizations/x?tab=roles&role=y`) — they are kept.
   */
  basePath: string;
  /** Query-string names; override when one page hosts several independent lists. */
  queryParam?: string;
  cursorParam?: string;
  initialQuery: string;
  placeholderKey: MessageKey;
  labelKey: MessageKey;
  clearKey: MessageKey;
}

/**
 * URL-driven search box for paginated list pages — debounces keystrokes into
 * a `router.replace` that updates `?q=`, always dropping any pagination
 * cursor at the same time (a new query invalidates it). No client state
 * holds the result set: the server component re-fetches on every navigation.
 */
export function ListSearch({ basePath, queryParam = "q", cursorParam = "after", initialQuery, placeholderKey, labelKey, clearKey }: ListSearchProps) {
  const { t } = useI18n();
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);

  useEffect(() => {
    setValue(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed === initialQuery.trim()) return;

    const timeout = setTimeout(() => {
      const [path = basePath, existing = ""] = basePath.split("?");
      const params = new URLSearchParams(existing);
      if (trimmed) params.set(queryParam, trimmed);
      else params.delete(queryParam);
      params.delete(cursorParam);
      router.replace(params.size > 0 ? `${path}?${params.toString()}` : path);
    }, 300);

    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <InputGroup className="max-w-sm">
      <InputGroupAddon>
        <IconSearch />
      </InputGroupAddon>
      <InputGroupInput
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={t(placeholderKey)}
        aria-label={t(labelKey)}
      />
      {value.length > 0 && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label={t(clearKey)} onClick={() => setValue("")}>
            <IconX />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

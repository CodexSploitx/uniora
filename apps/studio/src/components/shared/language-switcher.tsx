"use client";

import { IconCheck, IconLanguage } from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLocale } from "@/actions/locale";
import { LOCALES, type Locale } from "@/i18n/config";
import { useI18n } from "@/i18n/client";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const NAMES: Record<Locale, string> = { en: "English", es: "Español" };

export function LanguageSwitcher() {
  const { locale, t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" disabled={pending} aria-label={t("lang.label")} />}>
        <IconLanguage /> {locale.toUpperCase()}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
        <DropdownMenuLabel>{t("lang.label")}</DropdownMenuLabel>
        {LOCALES.map((option) => (
          <DropdownMenuItem
            key={option}
            onClick={() =>
              startTransition(async () => {
                await setLocale(option);
                router.refresh();
              })
            }
          >
            {NAMES[option]}
            {option === locale && <IconCheck className="ml-auto" />}
          </DropdownMenuItem>
        ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

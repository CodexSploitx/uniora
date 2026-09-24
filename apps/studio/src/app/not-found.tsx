import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getT } from "@/i18n/server";

export default async function NotFound() {
  const { t } = await getT();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="font-heading text-xl font-semibold">{t("notFound.title")}</h1>
      <p className="text-sm text-muted-foreground">{t("notFound.description")}</p>
      <Button render={<Link href="/" />}>{t("notFound.back")}</Button>
    </main>
  );
}

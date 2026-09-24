import type { Metadata } from "next";
import { Geist, Geist_Mono, JetBrains_Mono, Roboto_Slab } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import { ThemeProvider } from "@/components/shared/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { I18nProvider } from "@/i18n/client";
import { getT } from "@/i18n/server";

const robotoSlabHeading = Roboto_Slab({ subsets: ["latin"], variable: "--font-heading" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "UNIORA Studio",
  description: "Local-first admin UI for UNIORA organizations, roles, permissions and features.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const { locale, messages } = await getT();
  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={cn(
        "h-full antialiased font-mono",
        geistSans.variable,
        geistMono.variable,
        jetbrainsMono.variable,
        robotoSlabHeading.variable,
      )}
    >
      <body className="min-h-full">
        <I18nProvider locale={locale} messages={messages}>
          <ThemeProvider>
            <TooltipProvider>{children}</TooltipProvider>
            <Toaster position="bottom-right" />
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}

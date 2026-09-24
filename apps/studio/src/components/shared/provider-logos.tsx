import type { SVGProps } from "react";

/**
 * Official brand marks (Simple Icons, CC0) for the auth adapters UNIORA
 * ships in `@uniora/*` — inlined so the field works offline (Studio is
 * local-first). Each keeps its own official brand color (not
 * `currentColor`) so it reads as that provider's real mark; Better Auth's
 * official color is white, so `ProviderField` always draws these on a
 * fixed dark chip rather than the theme's own background.
 */
function SupabaseLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="#3FCF8E" xmlns="http://www.w3.org/2000/svg" {...props}>
      <title>Supabase</title>
      <path d="M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z" />
    </svg>
  );
}

function ClerkLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="#6C47FF" xmlns="http://www.w3.org/2000/svg" {...props}>
      <title>Clerk</title>
      <path d="m21.47 20.829-2.881-2.881a.572.572 0 0 0-.7-.084 6.854 6.854 0 0 1-7.081 0 .576.576 0 0 0-.7.084l-2.881 2.881a.576.576 0 0 0-.103.69.57.57 0 0 0 .166.186 12 12 0 0 0 14.113 0 .58.58 0 0 0 .239-.423.576.576 0 0 0-.172-.453Zm.002-17.668-2.88 2.88a.569.569 0 0 1-.701.084A6.857 6.857 0 0 0 8.724 8.08a6.862 6.862 0 0 0-1.222 3.692 6.86 6.86 0 0 0 .978 3.764.573.573 0 0 1-.083.699l-2.881 2.88a.567.567 0 0 1-.864-.063A11.993 11.993 0 0 1 6.771 2.7a11.99 11.99 0 0 1 14.637-.405.566.566 0 0 1 .232.418.57.57 0 0 1-.168.448Zm-7.118 12.261a3.427 3.427 0 1 0 0-6.854 3.427 3.427 0 0 0 0 6.854Z" />
    </svg>
  );
}

function Auth0Logo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="#EB5424" xmlns="http://www.w3.org/2000/svg" {...props}>
      <title>Auth0</title>
      <path d="M21.98 7.448L19.62 0H4.347L2.02 7.448c-1.352 4.312.03 9.206 3.815 12.015L12.007 24l6.157-4.552c3.755-2.81 5.182-7.688 3.815-12.015l-6.16 4.58 2.343 7.45-6.157-4.597-6.158 4.58 2.358-7.433-6.188-4.55 7.63-.045L12.008 0l2.356 7.404 7.615.044z" />
    </svg>
  );
}

function BetterAuthLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="#FFFFFF" xmlns="http://www.w3.org/2000/svg" {...props}>
      <title>Better Auth</title>
      <path d="M0 3.39v17.22h5.783V15.06h6.434V8.939H5.783V3.39ZM12.217 8.94h5.638v6.122h-5.638v5.548H24V3.391H12.217Z" />
    </svg>
  );
}

export interface KnownProvider {
  /** Exact `Identity.provider` string a real `@uniora/*` adapter produces (see each adapter's `identity.ts`). */
  key: string;
  label: string;
  Logo: (props: SVGProps<SVGSVGElement>) => React.JSX.Element;
}

/** The auth adapters this UNIORA install ships (docs/PROYECT.md §13-14) — kept in sync by hand when a new one ships. */
export const KNOWN_PROVIDERS: readonly KnownProvider[] = [
  { key: "supabase", label: "Supabase", Logo: SupabaseLogo },
  { key: "clerk", label: "Clerk", Logo: ClerkLogo },
  { key: "auth0", label: "Auth0", Logo: Auth0Logo },
  { key: "better-auth", label: "Better Auth", Logo: BetterAuthLogo },
];

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/** Lenient match (spacing/casing only) against a known adapter's exact provider string — informational, never a validation rule. */
export function matchKnownProvider(value: string): KnownProvider | undefined {
  const normalized = normalize(value);
  return KNOWN_PROVIDERS.find((provider) => provider.key === normalized);
}

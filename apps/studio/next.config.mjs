// .mjs (not .ts) on purpose: `next start` from an installed package must not need TypeScript to read it.
/** @type {import("next").NextConfig} */
const nextConfig = {
  // `pg` uses Node-only APIs (net/tls) and must not be bundled by Turbopack.
  serverExternalPackages: ["pg"],
  async headers() {
    return [
      {
        // Studio holds admin access to the database: never frameable (clickjacking),
        // never cached, never leaks its URL via Referer.
        source: "/((?!_next/).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;

// .mjs (not .ts) on purpose: `next start` from an installed package must not need TypeScript to read it.
/** @type {import("next").NextConfig} */
const nextConfig = {
  // `pg` uses Node-only APIs (net/tls) and `better-sqlite3` is a native addon: neither can be bundled.
  // `@uniora/sqlite` stays external too, so it resolves `better-sqlite3` from its own location at runtime.
  // `@uniora/mailer-smtp` is an optional peer (only needed to e-mail invitations), so it must resolve at runtime, not be bundled.
  serverExternalPackages: ["pg", "better-sqlite3", "@uniora/sqlite", "@uniora/mailer-smtp", "nodemailer"],
  // `serverExternalPackages` is not enough for `@uniora/sqlite` in this workspace: pnpm symlinks it to
  // packages/database/sqlite (outside node_modules), so webpack treats it as local code and bundles it.
  // Bundling freezes `import.meta.url` into the build machine's path (CI: file:///home/runner/...),
  // which makes `createRequire` throw ERR_INVALID_ARG_VALUE on Windows. Keep it external on the server.
  webpack(config, { isServer }) {
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : config.externals ? [config.externals] : []),
        ({ request }, callback) => (request === "@uniora/sqlite" ? callback(null, `module ${request}`) : callback()),
      ];
    }
    return config;
  },
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

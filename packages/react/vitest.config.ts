import { defineConfig } from "vitest/config";

// The only package in the monorepo that renders React components in tests
// — every other package runs its tests in plain Node, so this config is
// scoped to this package rather than the shared vitest setup.
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
});

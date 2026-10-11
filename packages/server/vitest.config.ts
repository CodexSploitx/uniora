import { defineConfig } from "vitest/config";

// With a real database (TEST_DATABASE_URL) every file truncates the same tables, so files take turns.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], fileParallelism: !process.env.TEST_DATABASE_URL, setupFiles: ["src/test-support/setup.ts"] },
});

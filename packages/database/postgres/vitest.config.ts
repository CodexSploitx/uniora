import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // Every integration file truncates and refills the same `uniora.*` tables (and now `uniora_platform.*`) of ONE test
    // database, so two files running at once would delete each other's rows mid-test: run the files one after another.
    fileParallelism: false,
  },
});

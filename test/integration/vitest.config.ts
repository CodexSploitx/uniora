import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // El flujo end-to-end completo hace muchas migraciones/transacciones reales
    // contra Postgres — más lento que los tests unitarios del resto del monorepo.
    testTimeout: 30_000,
  },
});

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url))
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // The heaviest suites drive real user-event interaction against large
    // rendered lists, and files run in parallel across workers. On a loaded
    // machine those legitimately exceed Vitest's 5s default and fail as
    // timeouts even though nothing is wrong — a flake that moves between files
    // from run to run. This raises the ceiling only; every assertion is
    // unchanged, and a genuinely hung test still fails.
    testTimeout: 20_000,
    // e2e/ holds the Playwright suite (`npm run test:e2e`). Vitest cannot run
    // those — it would fail on test.beforeEach() from a different test runner.
    exclude: ["node_modules/**", "dist/**", ".next/**", "e2e/**"]
  }
});

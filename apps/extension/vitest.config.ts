import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/__tests__/setup.ts"],
    // Dropdown adapters do bounded real-time waits (open/options/verify).
    testTimeout: 20000,
    include: ["src/**/*.test.ts"]
  }
});

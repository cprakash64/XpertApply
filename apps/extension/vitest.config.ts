import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/__tests__/setup.ts"],
    // Dropdown adapters do bounded real-time waits (open/options/verify).
    testTimeout: 20000,
    // Bounded, and the single setting used by developers and CI alike. Vitest's
    // default is availableParallelism() workers (8 here), each a full jsdom
    // process. On an 8 GiB laptop under ordinary load that starved the machine:
    // a run spent 660 s failing 75 times with "Failed to start forks worker /
    // Timeout waiting for worker to respond" and executed zero tests. Two
    // workers ran all 75 files, 1184 tests, in 67 s. Vitest 4 spells this
    // `maxWorkers`; `poolOptions.forks.maxForks` no longer exists.
    maxWorkers: 2,
    include: ["src/**/*.test.ts"]
  }
});

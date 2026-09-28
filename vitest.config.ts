import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Merges conformance shards once, after every worker; see test/conformance-global-setup.ts.
    globalSetup: ["./test/conformance-global-setup.ts"],
  },
});

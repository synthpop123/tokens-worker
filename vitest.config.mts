import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside workerd with real (miniflare-backed) D1/KV/R2 bindings
// read from wrangler.jsonc, so integration tests exercise the same code
// paths as production. Migrations are read here in Node and applied per
// test in test/setup.ts (isolated storage gives every test a fresh state).
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        fileURLToPath(new URL("./migrations", import.meta.url))
      );
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // The real secret lives on the Worker (and in .dev.vars locally),
            // never in the repo; tests bring their own.
            TOKENS_API_TOKEN: "test-token",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});

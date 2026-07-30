/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Injected by vitest.config.mts, consumed by test/setup.ts. */
      TEST_MIGRATIONS: D1Migration[];
      /**
       * Injected by vitest.config.mts. The test `env` is typed from
       * Cloudflare.Env, which must satisfy src's Env (secrets included)
       * to be passed to the Worker — and CI has no .dev.vars for
       * `wrangler types` to derive it from. Merging is safe: where both
       * declare it, the types are identical.
       */
      TOKENS_API_TOKEN: string;
    }
  }
}

export {};

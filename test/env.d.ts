/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Injected by vitest.config.mts, consumed by test/setup.ts. */
      TEST_MIGRATIONS: D1Migration[];
      /**
       * Injected by vitest.config.mts. Locally `wrangler types` also
       * derives this from .dev.vars, but CI machines have no .dev.vars,
       * so the generated Env lacks it there — this merge keeps the test
       * typecheck independent of that file. (Merging is safe: when both
       * declare it, the types are identical.)
       */
      TOKENS_API_TOKEN: string;
    }
  }
}

export {};

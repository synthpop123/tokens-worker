import { applyD1Migrations, env } from "cloudflare:test";

// Isolated storage hands every test an empty D1 snapshot; migrations are
// applied here so tests always see the current schema. Idempotent — the
// helper records applied migrations the same way `wrangler d1 migrations
// apply` does.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

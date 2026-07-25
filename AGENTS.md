# Agent notes

## Deploys are Git-driven — never run `wrangler deploy` manually

This Worker (`tokens-usage`) is connected to the GitHub repo via Cloudflare
Workers Builds. **Pushing to `main` is the deploy.** Every push builds and
deploys to production automatically (build command `npm run check` — the
type checks + vitest gate, a red run aborts the deploy; deploy command
`npx wrangler deploy` run by Cloudflare). Other branches get preview
versions only. The build command lives in the Cloudflare dashboard
(Workers Builds settings), not in the repo — if tests suddenly stop
gating deploys, check it there.

So when a change should go live: run `npm run check`, commit + push to
`main`, then (optionally) verify the build via the Cloudflare MCP tools
(`workers_builds_list_builds`; resolve the worker ID with the
`workers_list` tool first). Do NOT run `npx wrangler deploy` locally —
it deploys code Git doesn't know about, and the next push silently
overwrites it. There is intentionally no `deploy` script in
package.json. (`npx wrangler deploy --dry-run` is fine — it only
bundles locally, useful to prove the deploy packaging works.)

### Verifying or setting the build command

The wrangler OAuth token has **no Workers Builds scope** (none exists:
`npx wrangler login --scopes-list` offers no builds entry, so
re-authenticating cannot help), and the Builds API answers 403 with it —
a credential limitation, not a config problem. IDs are deliberately not
committed (this repo may go public); resolve them first:

- `$ACCOUNT_ID` — `npx wrangler whoami`
- `$WORKER_ID` — the Worker's script *tag*: dashboard URL, the
  `workers_list` MCP tool, or
  `GET /accounts/$ACCOUNT_ID/workers/scripts` (wrangler's scope covers
  this one)

Then either:

- **Dashboard:** Compute (Workers) → `tokens-usage` → Settings → Build →
  Build configuration → Build command = `npm run check`.
- **API** (token with account permission *Workers Builds Configuration:
  Edit*, created at dash.cloudflare.com/profile/api-tokens): read the
  triggers (one production, one preview — gate both), then patch —

  ```sh
  curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/builds/workers/$WORKER_ID/triggers"
  curl -s -X PATCH -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"build_command": "npm run check"}' \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/builds/triggers/$TRIGGER_UUID"
  ```

- **Ground truth after any push:** the Workers Builds log prints the
  executed build command (`GET .../builds/workers/$WORKER_ID/builds`,
  or the MCP tools above) — a `npm run check` line followed by the
  vitest summary is the proof the gate ran.

## Other facts that save a lookup

- Verify locally with `npm run check` (wrangler types + `tsc --noEmit`
 for src and tests + `vitest run`). Tests run inside workerd via
 `@cloudflare/vitest-pool-workers` against real miniflare-backed
 D1/KV/R2 bindings — see `test/`. GitHub Actions runs the same gate.
- `/api/site` is a versioned cross-repo contract: the body carries
 `schemaVersion` (`SITE_VERSION` in `src/site.ts`), which the homepage
 (`../homepage/src/lib/client/tokens.ts`, `SITE_SCHEMA_VERSION`)
 validates strictly and keys its sessionStorage cache by. Bump both
 together on any shape change and refresh the homepage's committed
 fixture (`src/lib/client/tokens.site-fixture.json`); the producer
 shape is pinned by `test/site.spec.ts`, the consumer by the
 homepage's `tokens.test.ts`.
- Write path is set-based: changed rows travel as JSON parameters
 expanded with `json_each`, one atomic D1 batch per submission. Never
 go back to per-row statements — D1 caps queries per invocation (50 on
 Free, counted per statement across batches).
- `/` serves `public/index.html` (Workers Static Assets) — a self-contained
 static homepage documenting the architecture and API, with live totals
 from `/api/site` and a light/dark toggle. When endpoints or merge
 semantics change, update it together with the README.
- The public read API serves a static `Access-Control-Allow-Origin: *`
  (`CORS_HEADERS` in `src/http.ts`). Never make response headers depend on
  the request's `Origin`: reads are browser-cacheable, and an
  Origin-dependent variant poisons the HTTP cache (a same-origin fetch of
  `/api/site` on this Worker's homepage once cached a no-CORS variant that
  broke the subsequent cross-origin read from lkwplus.com/tokens).
- `/api/site` freshness is event-driven, never TTL-guessed: every
  accepted submission rewrites the KV payload (ETag in its metadata),
  and responses serve `Cache-Control: no-cache` + that strong ETag, with
  `304` on `If-None-Match` (full CORS headers on the 304 too). There is
  deliberately no `caches.default` edge tier on this endpoint — it was
  the one layer no event could invalidate (and the scene of the CORS
  poisoning above). Don't reintroduce TTL heuristics here.
- All dates are calendar days in `Asia/Shanghai` (`TIME_ZONE` in
  `src/http.ts`).
- Secrets (`TOKENS_API_TOKEN`) live on the Worker, not in the repo;
  `wrangler.jsonc` holds bindings (D1/KV/R2) and plain vars.
- The Worker name in `wrangler.jsonc` (`tokens-usage`) must match the
  Cloudflare dashboard name, or Workers Builds fails.

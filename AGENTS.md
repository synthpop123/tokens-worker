# Agent notes

## Deploys are Git-driven — never run `wrangler deploy` manually

This Worker (`tokens-usage`) is connected to the GitHub repo via Cloudflare
Workers Builds. **Pushing to `main` is the deploy**: every push builds and
deploys to production, gated by the build command `npm run check` (a red
run aborts the deploy). Other branches get preview versions only.

So when a change should go live: run `npm run check`, commit, push to
`main`, then optionally verify the build via the Cloudflare MCP tools
(`workers_builds_list_builds`; resolve the worker id with `workers_list`
first). Do NOT run `npx wrangler deploy` locally — it deploys code Git
doesn't know about, and the next push silently overwrites it. There is
intentionally no `deploy` script. (`--dry-run` is fine: it only bundles.)

The build command lives in the Cloudflare dashboard (Compute → Workers →
`tokens-usage` → Settings → Build), not in the repo — if tests suddenly
stop gating deploys, check it there. Note the wrangler OAuth token has no
Workers Builds scope (none exists, so re-authenticating cannot help) and
the Builds API answers 403 with it; editing triggers over the API needs a
token with *Workers Builds Configuration: Edit*. Ground truth after any
push: the Workers Builds log prints the executed build command, so a
`npm run check` line followed by the vitest summary proves the gate ran.

## Other facts that save a lookup

- Verify locally with `npm run check` (wrangler types + `tsc` for src and
  for tests + `vitest run`). Tests run inside workerd via
  `@cloudflare/vitest-pool-workers` against real miniflare-backed D1/KV/R2
  bindings. GitHub Actions runs the same gate.
- `/api/site` is a versioned cross-repo contract: the body carries
  `schemaVersion` (`SITE_VERSION` in `src/site.ts`), which the homepage
  (`../homepage/src/lib/client/tokens.ts`, `SITE_SCHEMA_VERSION`)
  validates strictly and keys its sessionStorage cache by. Bump both
  together on any shape change and refresh the homepage's committed
  fixture (`src/lib/client/tokens.site-fixture.json`); the producer shape
  is pinned by `test/site.spec.ts`, the consumer by its `tokens.test.ts`.
- Migrations are append-only. D1 records applied migrations by filename,
  and `0003_rebuild.sql` starts with `DROP TABLE`, so renaming or
  collapsing the existing files would re-run a destructive migration
  against production data.
- Write path is set-based: changed rows travel as JSON parameters
  expanded with `json_each`, one atomic D1 batch per submission. Never go
  back to per-row statements — D1 caps queries per invocation (50 on
  Free, counted per statement across batches).
- Bindings and vars come from `wrangler.jsonc` through `wrangler types`
  (`Cloudflare.Env`), which `src/http.ts` extends with the one secret
  that cannot live there. Don't hand-maintain a binding list; it drifts.
- Never key a plain object by request input (query enum, route key, client
  / model / provider id). `Object.prototype` supplies `constructor`,
  `toString` and `__proto__`, so a lookup that should miss instead returns
  an inherited value: that turned `?interval=constructor` into interpolated
  SQL and a 500, and a client id of `__proto__` into a `/api/site` slice
  that vanished from the JSON while the day total still counted it. Use a
  `Map`, or `Object.create(null)` where the thing must serialize as a JSON
  object (`emptySlices` in `src/site.ts`).
- `/` serves `public/index.html` (Workers Static Assets) — a
  self-contained page documenting the architecture and API, with live
  totals from `/api/site`. Assets match before the router runs. When
  endpoints or merge semantics change, update it with the README.
- The public read API serves a static `Access-Control-Allow-Origin: *`
  (`CORS_HEADERS` in `src/http.ts`), error responses included. Never make
  response headers depend on the request's `Origin`: reads are
  browser-cacheable, and an Origin-dependent variant poisons the HTTP
  cache (a same-origin fetch of `/api/site` on this Worker's homepage
  once cached a no-CORS variant that broke the cross-origin read from
  lkwplus.com/tokens).
- `/api/site` freshness is event-driven, never TTL-guessed: every
  accepted submission rewrites the KV payload (ETag in its metadata), and
  responses serve `Cache-Control: no-cache` + that strong ETag, with
  `304` on `If-None-Match` (full CORS headers on the 304 too). There is
  deliberately no `caches.default` edge tier here — it was the one layer
  no event could invalidate, and the scene of the CORS poisoning above.
- All dates are calendar days in `Asia/Shanghai` (`TIME_ZONE` in
  `src/http.ts`).
- Secrets (`TOKENS_API_TOKEN`) live on the Worker, not in the repo. The
  Worker name in `wrangler.jsonc` (`tokens-usage`) must match the
  Cloudflare dashboard name, or Workers Builds fails.

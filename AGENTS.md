# Agent notes

## Deploys are Git-driven — never run `wrangler deploy` manually

This Worker (`tokens-usage`) is connected to the GitHub repo via Cloudflare
Workers Builds. **Pushing to `main` is the deploy.** Every push builds and
deploys to production automatically (no build command, deploy command
`npx wrangler deploy` run by Cloudflare). Other branches get preview
versions only.

So when a change should go live: commit + push to `main`, then (optionally)
verify the build via the Cloudflare MCP tools (`workers_builds_list_builds`
for worker ID `c57c130df3b748a1a736c04ce674d10f`). Do NOT run
`npm run deploy` / `npx wrangler deploy` locally — it deploys code Git
doesn't know about, and the next push silently overwrites it.

## Other facts that save a lookup

- Verify locally with `npm run types && npx tsc --noEmit`. There is no test
 suite.
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
- All dates are calendar days in `Asia/Shanghai` (`TIME_ZONE` in
  `src/http.ts`).
- Secrets (`TOKENS_API_TOKEN`) live on the Worker, not in the repo;
  `wrangler.jsonc` holds bindings (D1/KV/R2) and plain vars.
- The Worker name in `wrangler.jsonc` (`tokens-usage`) must match the
  Cloudflare dashboard name, or Workers Builds fails.

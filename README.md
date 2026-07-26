# tokens-worker

Self-hosted backend for the [`tokens`](https://github.com/missuo/tokens) CLI, running on Cloudflare Workers + D1 (+ KV for the precomposed site payload, R2 for backups) and served at [tokens.lkwplus.com](https://tokens.lkwplus.com).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/homepage-dark.png">
  <img src="docs/homepage-light.png" alt="Tokens Worker homepage — live totals, collector status and the write/fan-out/read architecture" width="100%">
</picture>

Each machine runs `tokens serve` with `TOKENS_API_URL=https://tokens.lkwplus.com`; the CLI POSTs a full rescan of its local session logs every 30 minutes. This Worker implements the official server's submission contract and merge semantics, stores the full usage matrix in D1, and exposes a filterable read API for the personal site.

Every accepted submission also (a) rewrites the precomposed `/api/site` payload in KV, (b) archives the raw payload to R2 (`raw/<deviceId>/latest.json` — submissions are full rescans, so the latest one reproduces the device's whole history), and (c) once per Asia/Shanghai day exports all four tables to R2 (`backup/YYYY-MM-DD.json`), a long-term backup beyond D1's 30-day Time Travel. Submissions are the only write event, so no cron is needed.

## Homepage

The root URL serves a static homepage (`public/index.html`, via [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)) documenting the architecture and the API: the write/fan-out/read data flow, the merge semantics, and an endpoint reference with copy-to-clipboard paths. The header shows live totals and collector status pulled from `/api/site`, plus a light/dark toggle (explicit choice persists in `localStorage`, otherwise it follows the system). Assets are matched before the Worker runs, so `/api/*` routing is untouched.

It is a single self-contained HTML file — no build step, no dependencies. The design tokens (gray scale, type scale, spacing) mirror lkwplus.com so the page reads as part of the site. Fonts are vendored copies of [Geist and Geist Mono](https://vercel.com/font) (SIL OFL 1.1). When endpoints or semantics change, update this page together with the README.

## Storage model

Usage is stored at maximum granularity — one row per **(device, date, client, model, provider)** with the full token breakdown (`input`, `output`, `cache_read`, `cache_write`, `reasoning`), `messages`, `cost`, and the parser revision that produced it. Everything the read API serves is an aggregation of this matrix, so any view the CLI can produce locally (per client / model / provider / device / arbitrary date window) can be reproduced remotely.

Sidecar tables: `daily_activity` (per-day `activeTimeMs`), `devices` (name, CLI version, time metrics, MCP server list), `submissions` (audit log of accepted submissions).

## Merge semantics (write path)

Ported from the official server (`web/src/app/api/submit/route.ts` + `lib/db/helpers.ts`; paths as of the upstream v27 rebuild, formerly under `packages/frontend/`):

- **Per-day, per-client replace.** A submission replaces each (device, day, client) bucket it mentions; clients or days it does not mention are left untouched.
- **Regression guard.** Within the same parser revision, a resubmit that would *reduce* a client's tokens for a day is ignored with a warning (local log cleanup can never erase stored history). A client that disappears from a day while still listed in `summary.clients` is preserved with a warning.
- **Parser revision floors.** A client whose `provenance.schemaVersion` is older than any revision already stored for that client on that device is rejected wholesale (stale-parser protection).
- **Authoritative coverage.** `clientManifest` entries with `coverage: {mode: "full", start, end}` (sent by `tokens submit --replace`) authoritatively replace that client within the window — including tombstoning days the new scan no longer contains.
- **Normalization.** The `kilocode`→`kilo` alias and empty `modelId`→`"unknown"`, as in the official server. Pre-v2 payload shapes (`sources`/`source` keys, per-day `timestampMs`) are intentionally not supported — only current CLIs report here.
- **Validation.** The official mathematical-consistency checks run on every submission (day totals vs client sums, summary vs calculated totals, future dates, duplicate dates, cost-without-tokens with the Cursor `premium-tool-call` carve-out). Failures return `400 {error: "Validation failed", details}`. Deviation: unknown client ids are accepted with a warning instead of rejected, so a newer CLI keeps working without a Worker redeploy.
- **Float-drift tolerance.** The CLI recomputes costs on every scan, so consecutive scans differ by ~1e-14; sub-1e-9 relative cost drift counts as "unchanged" and does not rewrite the day.
- **Atomic set-based writes.** Changed rows travel as JSON parameters expanded server-side with `json_each`, so a submission is a handful of statements (delete + insert + activity upsert + device + audit row) in **one D1 batch** — one transaction, no partial-write states — regardless of history size. This keeps even a full-history first upload far below D1's per-invocation query limits (50 on the Free plan, counted per statement across all batches).

## API

### CLI-facing endpoints

Every CLI endpoint requires `Authorization: Bearer $TOKENS_API_TOKEN`; the read API below is public.

| Endpoint | Auth | Used by | Description |
|---|---|---|---|
| `POST /api/submit` | yes | `tokens submit` / `serve` / `autosubmit` | Full submission payload; responds `{success, submissionId, username, metrics, mode, warnings?}` |
| `DELETE /api/settings/submitted-data` | yes | `tokens delete-submitted-data` | Wipes all stored data across all three stores — D1 tables, every R2 object (raw archives and daily backups reproduce submitted data, so they go too), and the KV site payload, recomposed synchronously so the dashboard is clean before the CLI hears "success"; responds `{deleted, deletedSubmissions}` |
| `GET /api/auth/token` | yes | `tokens login --token tt_...` | Token validation; responds `{user: {username}}` |
| `GET /api/me/stats` | yes | nothing current (was the `tokens tui` remote tab; CLI v27 removed the TUI) | Official schemaVersion-1 wire contract: totals, per-day series, device list. Kept for compatibility. Authenticated (like the official server) because it returns internal device ids, which the public read API never does |

Not implemented: the browser GitHub-OAuth device flow (`POST /api/auth/device[/poll]`); log in with `tokens login --token` instead.

### Public read endpoints (no auth; open CORS)

`/api/site` is freshness-critical (it backs the live dashboard), so it never guesses with TTLs: `Cache-Control: no-cache` plus a strong `ETag` make browsers revalidate every load — a ~0-byte `304` while the data is unchanged, the new payload the moment a submission rewrote it (worst case ~30 s, KV's per-PoP cache). The aggregate endpoints below it carry a plain 5-minute browser cache.

Internal device ids are never exposed — public rows identify devices by display name, and the `device=` filter takes names. Model and provider rows on the aggregate endpoints are merged under **canonical ids** (per-effort variants like `claude-fable-5-thinking-max` merged into `claude-fable-5`; subscription-auth provider spellings like pi's `openai-codex` merged into `openai` — rules + alias tables in `src/models.ts`); `/api/graph` keeps raw spellings as the full-fidelity export, and filters match raw ids. "Active days" count any activity, messages included (early-2025 Cursor logs carry message counts without token usage).

The four matrix endpoints (`/api/stats`, `/api/timeseries`, `/api/breakdown`, `/api/graph`) share one filter set, combinable freely:

- `from=YYYY-MM-DD`, `to=YYYY-MM-DD` — inclusive date bounds
- `client=`, `model=`, `provider=` — comma-separated exact matches (raw ids)
- `device=` — comma-separated device names

Comma lists are capped at 20 values each (keeps the worst case far below D1's 100-bound-parameters-per-query limit). Every endpoint declares the parameters it supports and answers anything else with a `400` — a filter that would otherwise be silently ignored is a lie in the response. `/api/meta` and `/api/devices` take no parameters; `/api/submissions` takes `limit` only.

Every aggregate row carries the full metric set: `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `tokens` (sum of the five), `messages`, `cost`.

| Endpoint | Description |
|---|---|
| `GET /api/site` | Precomposed dashboard view for lkwplus.com/tokens, one request for the whole page: per-range (`week`/`month`/`quarter`/`all`) totals + breakdowns (every model/client/provider row carries its usage span — `days`, `firstDate`, `lastDate`), full daily series split **by provider and by client** with per-day `active` time where reported (for the two trend stackings, weekday profile and heatmap), and the device inventory incl. CLI version, session count, active-time metrics and MCP servers. The body carries `schemaVersion` (`SITE_VERSION` in `src/site.ts`) — the cross-repo contract the homepage validates before rendering and keys its cache by; bump it on any shape change, together with the homepage's `SITE_SCHEMA_VERSION` and fixture. No filters; served from KV (rewritten on every accepted submission, ETag stored alongside as metadata) — requests never wait on D1. `Cache-Control: no-cache` + strong `ETag`, `304` on `If-None-Match` |
| `GET /api/stats` | Overview: `totals` (+ `activeDays`, `firstDate`, `lastDate`), `daily`, `byClient`, `byModel` (canonical, with `providers`), `byProvider`, `byDevice` (by name) |
| `GET /api/timeseries?interval=day\|week\|month\|year&group=none\|client\|model\|provider\|device` | `{series: [{period, key?, ...metrics}]}`, optionally split by one dimension — e.g. `interval=day&group=client` powers stacked area charts |
| `GET /api/breakdown?by=client,model&limit=` | Arbitrary multi-dimension rollup; `by` is any combination of `client`, `model`, `provider`, `device`, `date`, `month`, `year` (mirrors the CLI's `--group-by`) |
| `GET /api/graph?year=YYYY` | The same `TokenContributionData` shape as a `tokens graph` export (`meta`, `summary`, `years`, `contributions` with per-client rows, `intensity` 0–4, `activeTimeMs`), reconstructed from the matrix — both the heatmap source and a full-fidelity export (raw model ids); filters apply, so per-client graphs work |
| `GET /api/meta` | Distinct `clients`, `models` (raw + `canonical`, with provider), `providers`, device names, data `range`, `lastUpdatedAt` — for building filter UIs. No parameters |
| `GET /api/devices` | Device inventory: name, first/last seen, CLI version, time metrics, MCP servers, per-device totals. No parameters |
| `GET /api/submissions?limit=50` | Submission audit log (`mode`, `rowCount`, `changedDays`, `warningCount`, CLI version) for checking report cadence |
| `GET /api/health` | Liveness check (`/` serves the static homepage) |

Examples:

```sh
# Per-client daily series for a stacked chart, last 30 days
curl "https://tokens.lkwplus.com/api/timeseries?interval=day&group=client&from=2026-06-16"

# Top models across cursor only
curl "https://tokens.lkwplus.com/api/breakdown?by=model&client=cursor&limit=10"

# 2026 contribution graph for the heatmap
curl "https://tokens.lkwplus.com/api/graph?year=2026"
```

## Security & privacy

What this repo intentionally contains, and what it never does:

- **The only secret is `TOKENS_API_TOKEN`** (the write-path bearer token). It lives as a Worker secret in Cloudflare and in the gitignored `.dev.vars` locally — it has never been committed. The auth check hashes both sides and compares with the runtime's timing-safe primitive.
- **`wrangler.jsonc` carries resource identifiers, not credentials** — the D1 `database_id` and KV namespace `id` only name the bindings; access requires a Cloudflare API token that is not in the repo.
- **Reads are public by design.** The read API serves aggregate usage numbers for a personal dashboard. Internal device ids never appear on it — public rows identify devices by display name only (an integration test pins this) — and raw payloads / backups stay in the private R2 bucket. The one endpoint that does return device ids, `GET /api/me/stats`, requires the bearer token.

## Setup & deploy

One-time provisioning:

```sh
npm install
npx wrangler d1 create tokens-usage        # put the database_id into wrangler.jsonc
npx wrangler d1 migrations apply tokens-usage --remote
npx wrangler kv namespace create SITE_CACHE  # put the id into wrangler.jsonc
npx wrangler r2 bucket create tokens-archive
npx wrangler secret put TOKENS_API_TOKEN   # same token as in ~/.config/tokens/credentials.json
```

**Deploys are Git-driven and test-gated.** The Worker is connected to this GitHub repo via [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/): every push to `main` builds and deploys to production automatically (build command: `npm run check` — type checks + the vitest suite, a red run aborts the deploy; deploy command: `npx wrangler deploy`). Pushes to other branches upload a preview version without touching production. GitHub Actions (`.github/workflows/ci.yml`) runs the same gate on every push and pull request. There is deliberately no `deploy` script in package.json — a manual `npx wrangler deploy` is an emergency escape hatch only: it puts code live that Git doesn't know about, and the next push overwrites it.

The custom domain route (`tokens.lkwplus.com`) is declared in `wrangler.jsonc` and provisioned on deploy; `workers_dev` is disabled. `TOKENS_USERNAME` (a plain var in `wrangler.jsonc`) is the username echoed by `/api/auth/token` and submit responses. The Worker name in the Cloudflare dashboard must keep matching `name` in `wrangler.jsonc` (`tokens-usage`) or builds fail.

## Testing

`npm test` runs the vitest suite inside workerd via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/), against real (miniflare-backed) D1/KV/R2 bindings with the migrations applied — integration tests exercise the same code paths as production, no mocks:

- **Pure unit tests** — the merge engine (`test/merge.spec.ts`: regression guard, revision floors, authoritative coverage, float-tolerant day equality), payload validation (`test/payload.spec.ts`) and model/provider canonicalization (`test/models.spec.ts`).
- **Integration tests** (`test/worker.spec.ts`) — auth boundaries, the submit → merge → KV/R2 fan-out flow, idempotent resubmits, full-wipe delete semantics, the read API's query contract, and the device-id privacy rule.
- **Producer contract** (`test/site.spec.ts`) — the `/api/site` shape, mirrored consumer-side by the homepage's `isSite` decoder and its committed production fixture (homepage: `src/lib/client/tokens.test.ts`). Bump `SITE_VERSION` and the homepage's `SITE_SCHEMA_VERSION` together and refresh that fixture.

`npm run check` is the full gate (type generation + `tsc` over src and tests + vitest); it is what CI and the Workers Builds build command run before any deploy.

## Local development

```sh
npx wrangler d1 migrations apply tokens-usage --local
echo 'TOKENS_API_TOKEN=...' > .dev.vars   # gitignored
npm run dev                               # wrangler dev on :8787, local D1
npm run check                             # type-check src + tests, run the suite
```

Point a real CLI at it for an end-to-end test:

```sh
TOKENS_API_URL=http://localhost:8787 tokens submit
```

## Project layout

```
src/index.ts             Router + endpoint table
src/http.ts              Env, static CORS headers, timing-safe bearer auth, TZ
src/payload.ts           Submission types, normalization, official validation
src/merge.ts             Per-day per-client merge engine (regression guard,
                         revision floors, authoritative coverage)
src/submit.ts            Write path (atomic set-based D1 writes) + CLI-facing
                         endpoints; drives the KV site refresh and R2 archives
src/read.ts              Public read API (shared filter parser + per-endpoint
                         query contracts)
src/models.ts            Canonical model names shared by all aggregate
                         endpoints (suffix rules + alias table; extend
                         ALIASES for new spellings)
src/site.ts              /api/site — precomposed, schema-versioned dashboard
                         view (no-cache + ETag over KV over a single D1 batch)
src/backup.ts            Daily full-table export to R2 + full-wipe helper
test/                    Vitest suite (workerd runtime, real bindings):
                         unit specs for merge/payload/models, integration
                         specs for the API, /api/site producer contract
public/                  Static homepage (architecture + API reference),
                         served at / by Workers Static Assets
docs/                    README screenshots (not deployed)
migrations/              D1 schema (0003 is the current clean rebuild)
vitest.config.mts        vitest-pool-workers config (applies migrations,
                         injects a test bearer token)
.github/workflows/ci.yml npm ci + npm run check on every push / PR
wrangler.jsonc           Worker config (custom domain, D1/KV/R2 bindings,
                         static assets)
```

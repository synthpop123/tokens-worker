# tokens-worker

Self-hosted backend for the [`tokens`](https://github.com/missuo/tokens) CLI, running on Cloudflare Workers + D1 (+ KV for the precomposed site payload, R2 for backups) and served at [tokens.lkwplus.com](https://tokens.lkwplus.com).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/homepage-dark.png">
  <img src="docs/homepage-light.png" alt="Tokens Worker homepage — live totals, collector status and the write/fan-out/read architecture" width="100%">
</picture>

Each machine runs `tokens serve` with `TOKENS_API_URL=https://tokens.lkwplus.com`; the CLI POSTs a full rescan of its local session logs every 30 minutes. This Worker implements the official server's submission contract and merge semantics, stores the full usage matrix in D1, and exposes a filterable read API for the personal site.

Every accepted submission also (a) rewrites the precomposed `/api/site` payload in KV, (b) archives the raw payload to R2 (`raw/<deviceId>/latest.json` — submissions are full rescans, so the latest one reproduces the device's whole history), and (c) once per Asia/Shanghai day exports all four tables to R2 (`backup/YYYY-MM-DD.json`), a long-term backup beyond D1's 30-day Time Travel. Submissions are the only write event, so no cron is needed.

## Homepage

The root URL serves a static homepage (`public/index.html`, via [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)) documenting the architecture and the API, with live totals and collector status pulled from `/api/site` and a light/dark toggle. Assets are matched before the Worker runs, so `/api/*` routing is untouched.

One self-contained HTML file — no build step, no dependencies. The design tokens mirror lkwplus.com so the page reads as part of the site; fonts are vendored copies of [Geist and Geist Mono](https://vercel.com/font) (SIL OFL 1.1). When endpoints or semantics change, update this page together with the README.

## Storage model

Usage is stored at maximum granularity — one row per **(device, date, client, model, provider)** with the full token breakdown (`input`, `output`, `cache_read`, `cache_write`, `reasoning`), `messages`, `cost`, and the parser revision that produced it. Everything the read API serves is an aggregation of this matrix, so any view the CLI can produce locally (per client / model / provider / device / arbitrary date window) can be reproduced remotely.

Sidecar tables: `daily_activity` (per-day `activeTimeMs`), `devices` (name, CLI version, time metrics, MCP server list), `submissions` (audit log of accepted submissions).

Migrations are **append-only**: D1 tracks them by filename, and `0003` drops and recreates the tables, so renaming or collapsing the applied files would re-run a destructive migration against production.

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

| Endpoint | Used by | Description |
|---|---|---|
| `POST /api/submit` | `tokens submit` / `serve` / `autosubmit` | Full submission payload; responds `{success, submissionId, username, metrics, mode, warnings?}` |
| `DELETE /api/settings/submitted-data` | `tokens delete-submitted-data` | Wipes all stored data across all three stores — D1 tables, every R2 object (raw archives and daily backups reproduce submitted data, so they go too), and the KV site payload, recomposed synchronously so the dashboard is clean before the CLI hears "success"; responds `{deleted, deletedSubmissions}` |
| `GET /api/auth/token` | `tokens login --token tt_...` | Token validation; responds `{user: {username}}` |
| `GET /api/me/stats` | nothing current (was the `tokens tui` remote tab, removed in CLI v27) | Official schemaVersion-1 wire contract: totals, per-day series, device list. Kept for compatibility, and authenticated like the official server because it returns internal device ids |

Not implemented: the browser GitHub-OAuth device flow (`POST /api/auth/device[/poll]`); log in with `tokens login --token` instead.

### Public read endpoints (no auth; open CORS)

`/api/site` is freshness-critical (it backs the live dashboard), so it never guesses with TTLs: `Cache-Control: no-cache` plus a strong `ETag` make browsers revalidate every load — a ~0-byte `304` while the data is unchanged, the new payload the moment a submission rewrote it (worst case ~30 s, KV's per-PoP cache). The aggregate endpoints carry a plain 5-minute browser cache; `/api/submissions` is uncached, being the log you refresh to check whether the last submission landed.

Internal device ids are never exposed — public rows identify devices by display name, and the `device=` filter takes names. Model and provider rows on the aggregate endpoints are merged under **canonical ids** (per-effort variants like `claude-fable-5-thinking-max` merged into `claude-fable-5`; subscription-auth provider spellings like pi's `openai-codex` merged into `openai`), and canonical providers mean **model vendors**: rows whose client reported its own serving gateway as the provider (Zed's `zed.dev`, OpenCode's zen `opencode`) are re-attributed by model name with the same inference rules the CLI's cursor parser uses (a Claude model via Zed counts as `anthropic`, GLM via OpenCode zen as `zai`), while models the rules can't place (`composer-*`, `big-pickle`, ...) stay under the gateway id — rules + alias tables in `src/models.ts`. `/api/graph` keeps raw spellings as the full-fidelity export, and filters match raw ids. "Active days" count any activity, messages included (early-2025 Cursor logs carry message counts without token usage).

The four matrix endpoints (`/api/stats`, `/api/timeseries`, `/api/breakdown`, `/api/graph`) share one filter set, combinable freely:

- `from=YYYY-MM-DD`, `to=YYYY-MM-DD` — inclusive date bounds
- `client=`, `model=`, `provider=` — comma-separated exact matches (raw ids), at most 20 values each (keeping the worst case far below D1's 100-bound-parameters-per-query limit)
- `device=` — comma-separated device names

Every endpoint declares the parameters it supports and answers anything else with a `400`, error responses included in the CORS headers so a browser can read the reason. A filter that would otherwise be silently ignored — or a `limit` silently clamped — is a lie in the response, so out-of-range values are rejected rather than adjusted. `/api/meta` and `/api/devices` take no parameters; `/api/submissions` takes `limit` only. A known path with the wrong method answers `405` with `Allow`.

Every aggregate row carries the full metric set: `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `tokens` (sum of the five), `messages`, `cost`.

| Endpoint | Description |
|---|---|
| `GET /api/site` | Precomposed dashboard view, one request for the whole page: per-range (`day`/`week`/`month`/`quarter`/`all`, where `day` is today in Asia/Shanghai — it backs the dashboard's Today section and is the only per-model split of a single day) totals + breakdowns (every row carries its usage span — `days`, `firstDate`, `lastDate`), the full daily series split **by provider and by client** with per-day `active` time, and the device inventory incl. CLI version, sessions, active-time metrics and MCP servers. No filters; served from KV. The body carries `schemaVersion` — see [Cross-repo contract](#cross-repo-contract) |
| `GET /api/stats` | Overview: `totals` (+ `activeDays`, `firstDate`, `lastDate`), `daily`, `byClient`, `byModel` (canonical, with `providers`), `byProvider`, `byDevice` (by name) |
| `GET /api/timeseries?interval=day\|week\|month\|year&group=none\|client\|model\|provider\|device` | `{series: [{period, key?, ...metrics}]}`, optionally split by one dimension — e.g. `interval=day&group=client` powers stacked area charts |
| `GET /api/breakdown?by=client,model&limit=` | Arbitrary multi-dimension rollup; `by` is any combination of `client`, `model`, `provider`, `device`, `date`, `month`, `year` (mirrors the CLI's `--group-by`); `limit` 1–10000 |
| `GET /api/graph?year=YYYY` | The same `TokenContributionData` shape as a `tokens graph` export (`meta`, `summary`, `years`, `contributions` with per-client rows, `intensity` 0–4, `activeTimeMs`), reconstructed from the matrix — both the heatmap source and a full-fidelity export (raw model ids); filters apply, so per-client graphs work |
| `GET /api/meta` | Distinct `clients`, `models` (raw + `canonical`, with provider), `providers`, device names, data `range`, `lastUpdatedAt` — for building filter UIs |
| `GET /api/devices` | Device inventory: name, first/last seen, CLI version, time metrics, MCP servers, per-device totals |
| `GET /api/submissions?limit=50` | Submission audit log (`mode`, `rowCount`, `changedDays`, `warningCount`, CLI version) for checking report cadence; `limit` 1–500 |
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

### Cross-repo contract

`/api/site` is versioned: the body carries `schemaVersion` (`SITE_VERSION` in `src/site.ts`), which the homepage (`../homepage/src/lib/client/tokens.ts`, `SITE_SCHEMA_VERSION`) validates strictly and keys its cache by, so a stale cache or a mid-deploy mismatch falls back to a refetch instead of a renderer crash. Bump both together on any shape change and refresh the homepage's committed fixture (`src/lib/client/tokens.site-fixture.json`). The producer shape is pinned by `test/site.spec.ts`, the consumer by the homepage's `tokens.test.ts`.

## Security & privacy

- **The only secret is `TOKENS_API_TOKEN`** (the write-path bearer token). It lives as a Worker secret in Cloudflare and in the gitignored `.dev.vars` locally — never committed. The auth check hashes both sides and compares with the runtime's timing-safe primitive.
- **`wrangler.jsonc` carries resource identifiers, not credentials** — the D1 `database_id` and KV namespace `id` only name the bindings; access requires a Cloudflare API token that is not in the repo.
- **Reads are public by design** — aggregate usage numbers for a personal dashboard. Internal device ids never appear on them (an integration test pins this), and raw payloads / backups stay in the private R2 bucket. The one endpoint that returns device ids, `GET /api/me/stats`, requires the bearer token.
- **CORS is a static wildcard, never Origin-derived.** Reads are cacheable, and an Origin-dependent header on a cacheable response poisons caches (`src/http.ts` documents the incident).

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

**Deploys are Git-driven and test-gated.** The Worker is connected to this repo via [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/): every push to `main` builds and deploys to production (build command `npm run check`, so a red run aborts the deploy). Other branches upload a preview version without touching production, and GitHub Actions (`.github/workflows/ci.yml`) runs the same gate on every push and PR. There is deliberately no `deploy` script — a manual `npx wrangler deploy` puts code live that Git doesn't know about, and the next push overwrites it.

The custom domain route (`tokens.lkwplus.com`) is declared in `wrangler.jsonc` and provisioned on deploy; `workers_dev` is disabled. `TOKENS_USERNAME` (a plain var there) is the username echoed by `/api/auth/token` and submit responses. The Worker name in the Cloudflare dashboard must keep matching `name` in `wrangler.jsonc` (`tokens-usage`) or builds fail.

## Local development

```sh
npx wrangler d1 migrations apply tokens-usage --local
echo 'TOKENS_API_TOKEN=...' > .dev.vars   # gitignored
npm run dev                               # wrangler dev on :8787, local D1
npm run check                             # the full gate
TOKENS_API_URL=http://localhost:8787 tokens submit   # end-to-end with a real CLI
```

`npm run check` = `wrangler types` + `tsc` over src + `tsc` over tests (the two passes are separate on purpose: src must typecheck without the tests' type augmentations) + `vitest run`.

Tests run inside workerd via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) against real (miniflare-backed) D1/KV/R2 bindings with migrations applied, so integration tests exercise the production code paths with no mocks:

- **Unit** — merge engine (`test/merge.spec.ts`), payload validation (`test/payload.spec.ts`), model/provider canonicalization (`test/models.spec.ts`).
- **Integration** (`test/worker.spec.ts`) — auth boundaries, the submit → merge → KV/R2 fan-out, idempotent resubmits, full-wipe delete semantics, the read API's query contract, the device-id privacy rule.
- **Producer contract** (`test/site.spec.ts`) — the `/api/site` shape, mirrored consumer-side by the homepage's decoder and fixture.

## Project layout

```
src/index.ts             Router (one "METHOD /path" -> handler table)
src/http.ts              Env, static CORS headers, timing-safe bearer auth, TZ
src/metrics.ts           The metric set: TS shape, SQL projection, fold helpers
src/payload.ts           Submission types, normalization, official validation
src/merge.ts             Per-day per-client merge engine (regression guard,
                         revision floors, authoritative coverage)
src/submit.ts            Write path (atomic set-based D1 writes) + CLI-facing
                         endpoints; drives the KV site refresh and R2 archives
src/read.ts              Public read API (one query parser + per-endpoint
                         contracts)
src/models.ts            Canonical model/provider ids (suffix rules + alias
                         tables; extend ALIASES for new spellings)
src/site.ts              /api/site — precomposed, schema-versioned dashboard
                         view (no-cache + ETag over KV over one D1 batch)
src/backup.ts            Daily full-table export to R2 + full-wipe helper
test/                    Vitest suite (workerd runtime, real bindings)
public/                  Static homepage, served at / by Workers Static Assets
docs/                    README screenshots (not deployed)
migrations/              D1 schema, append-only (0003 is the current rebuild)
vitest.config.mts        vitest-pool-workers config (migrations, test token)
wrangler.jsonc           Worker config (domain, D1/KV/R2 bindings, assets)
```

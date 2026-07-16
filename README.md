# tokens-worker

Self-hosted backend for the [`tokens`](https://github.com/missuo/tokens) CLI, running on Cloudflare Workers + D1 and served at `https://tokens.lkwplus.com`.

Each machine runs `tokens serve` with `TOKENS_API_URL=https://tokens.lkwplus.com`; the CLI POSTs a full rescan of its local session logs every 30 minutes. This Worker implements the official server's submission contract and merge semantics, stores the full usage matrix in D1, and exposes a filterable read API for the personal site.

## Storage model

Usage is stored at maximum granularity — one row per **(device, date, client, model, provider)** with the full token breakdown (`input`, `output`, `cache_read`, `cache_write`, `reasoning`), `messages`, `cost`, and the parser revision that produced it. Everything the read API serves is an aggregation of this matrix, so any view the CLI can produce locally (per client / model / provider / device / arbitrary date window) can be reproduced remotely.

Sidecar tables: `daily_meta` (per-day `timestampMs` earliest-wins, `activeTimeMs`), `devices` (name, CLI version, time metrics, MCP server list), `submissions` (audit log of accepted submissions).

## Merge semantics (write path)

Ported from the official server (`packages/frontend/src/app/api/submit/route.ts` + `lib/db/helpers.ts`):

- **Per-day, per-client replace.** A submission replaces each (device, day, client) bucket it mentions; clients or days it does not mention are left untouched.
- **Regression guard.** Within the same parser revision, a resubmit that would *reduce* a client's tokens for a day is ignored with a warning (local log cleanup can never erase stored history). A client that disappears from a day while still listed in `summary.clients` is preserved with a warning.
- **Parser revision floors.** A client whose `provenance.schemaVersion` is older than any revision already stored for that client on that device is rejected wholesale (stale-parser protection).
- **Authoritative coverage.** `clientManifest` entries with `coverage: {mode: "full", start, end}` (sent by `tokens submit --replace`) authoritatively replace that client within the window — including tombstoning days the new scan no longer contains.
- **Legacy normalization.** `sources`/`source` payload keys, the `kilocode`→`kilo` alias, and empty `modelId`→`"unknown"` are normalized exactly like the official server.
- **Validation.** The official mathematical-consistency checks run on every submission (day totals vs client sums, summary vs calculated totals, future dates, duplicate dates, cost-without-tokens with the Cursor `premium-tool-call` carve-out). Failures return `400 {error: "Validation failed", details}`. Deviation: unknown client ids are accepted with a warning instead of rejected, so a newer CLI keeps working without a Worker redeploy.

## API

### CLI-facing endpoints (Bearer auth: `TOKENS_API_TOKEN`)

| Endpoint | Used by | Description |
|---|---|---|
| `POST /api/submit` | `tokens submit` / `serve` / `autosubmit` | Full submission payload; responds `{success, submissionId, username, metrics, mode, warnings?}` |
| `GET /api/auth/token` | `tokens login --token tt_...` | Token validation; responds `{user: {username}}` |
| `GET /api/me/stats` | `tokens tui` remote tab | Official schemaVersion-1 wire contract: totals, per-day series, device list |
| `DELETE /api/settings/submitted-data` | `tokens delete-submitted-data` | Wipes all stored data; responds `{deleted, deletedSubmissions}` |
| `GET /api/submissions?limit=50` | (self-host extra) | Submission audit log for debugging report cadence |

Not implemented: the browser GitHub-OAuth device flow (`POST /api/auth/device[/poll]`); log in with `tokens login --token` instead.

### Public read endpoints (CORS: lkwplus.com + localhost, 5-min cache)

All of them accept the same filters, combinable freely:

- `from=YYYY-MM-DD`, `to=YYYY-MM-DD` — inclusive date bounds
- `client=`, `model=`, `provider=`, `device=` — comma-separated exact matches

Every aggregate row carries the full metric set: `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `tokens` (sum of the five), `messages`, `cost`.

| Endpoint | Description |
|---|---|
| `GET /api/stats` | Overview: `totals` (+ `activeDays`, `firstDate`, `lastDate`), `daily`, `byClient`, `byModel` (with `providers`), `byProvider`, `byDevice` |
| `GET /api/timeseries?interval=day\|week\|month\|year&group=none\|client\|model\|provider\|device` | Time series, optionally split by one dimension — e.g. `interval=day&group=client` powers stacked area charts |
| `GET /api/breakdown?by=client,model&limit=` | Arbitrary multi-dimension rollup; `by` is any combination of `client`, `model`, `provider`, `device`, `date`, `month`, `year` (mirrors the CLI's `--group-by`) |
| `GET /api/graph?year=YYYY` | Contribution graph: per-day `totals` + `tokenBreakdown` + `intensity` 0–4 (same cost-ratio thresholds as the CLI) plus per-year summaries; filters apply, so per-client graphs work |
| `GET /api/meta` | Distinct `clients`, `models` (with provider), `providers`, `devices`, data `range`, `lastUpdatedAt` — for building filter UIs |
| `GET /api/devices` | Device inventory: name, first/last seen, CLI version, time metrics, MCP servers, per-device totals |
| `GET /api/health` (also `/`) | Liveness check |

Examples:

```sh
# Per-client daily series for a stacked chart, last 30 days
curl "https://tokens.lkwplus.com/api/timeseries?interval=day&group=client&from=2026-06-16"

# Top models across cursor only
curl "https://tokens.lkwplus.com/api/breakdown?by=model&client=cursor&limit=10"

# 2026 contribution graph for the heatmap
curl "https://tokens.lkwplus.com/api/graph?year=2026"
```

## Setup & deploy

```sh
npm install
npx wrangler d1 create tokens-usage        # put the database_id into wrangler.jsonc
npx wrangler d1 migrations apply tokens-usage --remote
npx wrangler secret put TOKENS_API_TOKEN   # same token as in ~/.config/tokens/credentials.json
npm run deploy
```

The custom domain route (`tokens.lkwplus.com`) is declared in `wrangler.jsonc` and provisioned on deploy; `workers_dev` is disabled. `TOKENS_USERNAME` (a plain var in `wrangler.jsonc`) is the username echoed by `/api/auth/token` and submit responses.

## Local development

```sh
npx wrangler d1 migrations apply tokens-usage --local
echo 'TOKENS_API_TOKEN=...' > .dev.vars   # gitignored
npm run dev                               # wrangler dev on :8787, local D1
npm run types && npx tsc --noEmit         # type-check
```

Point a real CLI at it for an end-to-end test:

```sh
TOKENS_API_URL=http://localhost:8787 tokens submit
```

## Project layout

```
src/index.ts             Router + endpoint table
src/http.ts              Env, CORS allowlist, constant-time bearer auth
src/payload.ts           Submission types, normalization, official validation
src/merge.ts             Per-day per-client merge engine (regression guard,
                         revision floors, authoritative coverage)
src/submit.ts            Write path + CLI-facing endpoints
src/read.ts              Public read API (shared filter parser)
migrations/              D1 schema (0001 base matrix, 0002 full fidelity)
wrangler.jsonc           Worker config (custom domain, D1 binding, vars)
```

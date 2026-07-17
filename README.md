# tokens-worker

Self-hosted backend for the [`tokens`](https://github.com/missuo/tokens) CLI, running on Cloudflare Workers + D1 and served at `https://tokens.lkwplus.com`.

Each machine runs `tokens serve` with `TOKENS_API_URL=https://tokens.lkwplus.com`; the CLI POSTs a full rescan of its local session logs every 30 minutes. This Worker implements the official server's submission contract and merge semantics, stores the full usage matrix in D1, and exposes a filterable read API for the personal site.

## Storage model

Usage is stored at maximum granularity — one row per **(device, date, client, model, provider)** with the full token breakdown (`input`, `output`, `cache_read`, `cache_write`, `reasoning`), `messages`, `cost`, and the parser revision that produced it. Everything the read API serves is an aggregation of this matrix, so any view the CLI can produce locally (per client / model / provider / device / arbitrary date window) can be reproduced remotely.

Sidecar tables: `daily_activity` (per-day `activeTimeMs`), `devices` (name, CLI version, time metrics, MCP server list), `submissions` (audit log of accepted submissions).

## Merge semantics (write path)

Ported from the official server (`packages/frontend/src/app/api/submit/route.ts` + `lib/db/helpers.ts`):

- **Per-day, per-client replace.** A submission replaces each (device, day, client) bucket it mentions; clients or days it does not mention are left untouched.
- **Regression guard.** Within the same parser revision, a resubmit that would *reduce* a client's tokens for a day is ignored with a warning (local log cleanup can never erase stored history). A client that disappears from a day while still listed in `summary.clients` is preserved with a warning.
- **Parser revision floors.** A client whose `provenance.schemaVersion` is older than any revision already stored for that client on that device is rejected wholesale (stale-parser protection).
- **Authoritative coverage.** `clientManifest` entries with `coverage: {mode: "full", start, end}` (sent by `tokens submit --replace`) authoritatively replace that client within the window — including tombstoning days the new scan no longer contains.
- **Normalization.** The `kilocode`→`kilo` alias and empty `modelId`→`"unknown"`, as in the official server. Pre-v2 payload shapes (`sources`/`source` keys, per-day `timestampMs`) are intentionally not supported — only current CLIs report here.
- **Validation.** The official mathematical-consistency checks run on every submission (day totals vs client sums, summary vs calculated totals, future dates, duplicate dates, cost-without-tokens with the Cursor `premium-tool-call` carve-out). Failures return `400 {error: "Validation failed", details}`. Deviation: unknown client ids are accepted with a warning instead of rejected, so a newer CLI keeps working without a Worker redeploy.
- **Float-drift tolerance.** The CLI recomputes costs on every scan, so consecutive scans differ by ~1e-14; sub-1e-9 relative cost drift counts as "unchanged" and does not rewrite the day.
- **Chunked writes.** A day's DELETE+INSERTs always land in the same D1 batch; a full-history first upload spans several batches, and a mid-flight failure leaves prior days consistent for the next idempotent resubmit to heal.

## API

### CLI-facing endpoints

Writes require `Authorization: Bearer $TOKENS_API_TOKEN`; reads are public.

| Endpoint | Auth | Used by | Description |
|---|---|---|---|
| `POST /api/submit` | yes | `tokens submit` / `serve` / `autosubmit` | Full submission payload; responds `{success, submissionId, username, metrics, mode, warnings?}` |
| `DELETE /api/settings/submitted-data` | yes | `tokens delete-submitted-data` | Wipes all stored data; responds `{deleted, deletedSubmissions}` |
| `GET /api/auth/token` | yes | `tokens login --token tt_...` | Token validation; responds `{user: {username}}` |
| `GET /api/me/stats` | no | `tokens tui` remote tab | Official schemaVersion-1 wire contract: totals, per-day series, device list |

Not implemented: the browser GitHub-OAuth device flow (`POST /api/auth/device[/poll]`); log in with `tokens login --token` instead.

### Public read endpoints (no auth; CORS: lkwplus.com + localhost; 5-min cache)

All of them accept the same filters, combinable freely:

- `from=YYYY-MM-DD`, `to=YYYY-MM-DD` — inclusive date bounds
- `client=`, `model=`, `provider=`, `device=` — comma-separated exact matches

Every aggregate row carries the full metric set: `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `tokens` (sum of the five), `messages`, `cost`.

| Endpoint | Description |
|---|---|
| `GET /api/site` | Precomposed dashboard view for lkwplus.com/tokens, one request for the whole page: per-range (`week`/`month`/`quarter`/`all`) totals + breakdowns with **canonical model names** (per-effort variants like `claude-fable-5-thinking-max` merged into `claude-fable-5` — rules + alias table in `src/models.ts`), full daily series split by provider with per-day `active` time where reported (for the stacked trend chart, weekday profile and heatmap), and the device inventory incl. CLI version, session count, active-time metrics and MCP servers. No filters; served from the edge cache (5 min, versioned cache key — bump `?v=` in `src/site.ts` on shape changes) so page loads normally skip D1 entirely |
| `GET /api/stats` | Overview: `totals` (+ `activeDays`, `firstDate`, `lastDate`), `daily`, `byClient`, `byModel` (with `providers`), `byProvider`, `byDevice` — raw model spellings |
| `GET /api/timeseries?interval=day\|week\|month\|year&group=none\|client\|model\|provider\|device` | `{series: [{period, key?, ...metrics}]}`, optionally split by one dimension — e.g. `interval=day&group=client` powers stacked area charts |
| `GET /api/breakdown?by=client,model&limit=` | Arbitrary multi-dimension rollup; `by` is any combination of `client`, `model`, `provider`, `device`, `date`, `month`, `year` (mirrors the CLI's `--group-by`) |
| `GET /api/graph?year=YYYY` | The same `TokenContributionData` shape as a `tokens graph` export (`meta`, `summary`, `years`, `contributions` with per-client rows, `intensity` 0–4, `activeTimeMs`), reconstructed from the matrix — both the heatmap source and a full-fidelity export; filters apply, so per-client graphs work |
| `GET /api/meta` | Distinct `clients`, `models` (with provider), `providers`, `devices`, data `range`, `lastUpdatedAt` — for building filter UIs |
| `GET /api/devices` | Device inventory: name, first/last seen, CLI version, time metrics, MCP servers, per-device totals |
| `GET /api/submissions?limit=50` | Submission audit log (`mode`, `rowCount`, `changedDays`, `warningCount`, CLI version) for checking report cadence |
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
src/models.ts            Canonical model names for /api/site (suffix rules +
                         alias table; extend ALIASES for new spellings)
src/site.ts              /api/site — precomposed, edge-cached dashboard view
migrations/              D1 schema (0003 is the current clean rebuild)
wrangler.jsonc           Worker config (custom domain, D1 binding, vars)
```

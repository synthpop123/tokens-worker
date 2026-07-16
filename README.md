# tokens-worker

Self-hosted backend for the [`tokens`](https://github.com/missuo/tokens) CLI, running on Cloudflare Workers + D1 and served at `https://tokens.lkwplus.com`.

Each machine runs `tokens serve` with `TOKENS_API_URL=https://tokens.lkwplus.com`; the CLI POSTs a full rescan of its local session logs every 30 minutes. This Worker ingests those submissions into D1 and exposes an aggregated read API for the personal site.

## How it works

- The CLI always submits a **full rescan** of local logs, never a delta. The Worker therefore treats every write as an idempotent, `max()`-guarded upsert keyed by `(device, date, client, model, provider)`:
  - Re-submitting the same data is a no-op.
  - A rescan that *shrank* (because local session logs were cleaned up by retention) can never erase history already stored here — stored counters only ever go up.
- Rows within one submission that share the same key are summed before upserting.
- Every accepted submission is also recorded in a lightweight `submissions` audit table, useful for checking report cadence and spotting devices that stopped reporting.

## API

### `POST /api/submit`

Ingests a CLI submission. Requires `Authorization: Bearer <TOKENS_API_TOKEN>` (verified with a constant-time comparison).

Request body (shape produced by the `tokens` CLI):

```json
{
  "meta": { "dateRange": { "start": "2026-06-01", "end": "2026-07-16" } },
  "device": { "id": "mbp-lkw", "name": "MacBook Pro" },
  "summary": { "totalTokens": 123456, "totalCost": 1.23, "activeDays": 12 },
  "contributions": [
    {
      "date": "2026-07-16",
      "totals": { "tokens": 4200, "cost": 0.05, "messages": 10 },
      "clients": [
        {
          "client": "cursor",
          "modelId": "claude-sonnet",
          "providerId": "anthropic",
          "tokens": { "input": 3000, "output": 900, "cacheRead": 200, "cacheWrite": 50, "reasoning": 50 },
          "cost": 0.05,
          "messages": 10
        }
      ]
    }
  ]
}
```

Responses:

- `200` — `{ submissionId, metrics: { totalTokens, totalCost, activeDays }, warnings? }`. Malformed rows are skipped and reported in `warnings` (first 20).
- `400` — invalid JSON, or no usable rows and at least one row-level error.
- `401` — missing/incorrect bearer token.

### `GET /api/stats?from=YYYY-MM-DD&to=YYYY-MM-DD`

Public read endpoint (no auth). Both query params are optional; omitting them returns all-time stats. Responses are cached for 5 minutes (`Cache-Control: public, max-age=300`) and CORS is allowed for `lkwplus.com`, `www.lkwplus.com`, and `http://localhost:*`.

```json
{
  "range": { "from": "2026-07-01", "to": "2026-07-16" },
  "totals": { "tokens": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0, "messages": 0, "cost": 0, "activeDays": 0 },
  "daily":    [ { "date": "2026-07-16", "tokens": 0, "cost": 0, "messages": 0 } ],
  "byClient": [ { "client": "cursor", "tokens": 0, "cost": 0, "messages": 0 } ],
  "byModel":  [ { "model": "claude-sonnet", "tokens": 0, "cost": 0, "messages": 0 } ],
  "byDevice": [ { "deviceId": "mbp-lkw", "name": "MacBook Pro", "tokens": 0, "cost": 0, "lastSeen": 0 } ]
}
```

`tokens` everywhere means `input + output + cache_read + cache_write + reasoning`.

### `GET /api/health` (also `GET /`)

Liveness check, returns `{ "service": "tokens-usage", "ok": true }`.

## Data model

Three tables (see `migrations/0001_init.sql`):

| Table | Purpose |
|---|---|
| `daily_usage` | One row per `(device_id, date, client, model, provider)` with token breakdown (`input`, `output`, `cache_read`, `cache_write`, `reasoning`), `messages`, and `cost` |
| `devices` | Device id → display name, `first_seen` / `last_seen` timestamps |
| `submissions` | Audit log of accepted submissions (received time, date range, row count, reported totals) |

## Setup & deploy

```sh
npm install
npx wrangler d1 create tokens-usage        # put the database_id into wrangler.jsonc
npx wrangler d1 migrations apply tokens-usage --remote
npx wrangler secret put TOKENS_API_TOKEN   # same token as in ~/.config/tokens/credentials.json
npm run deploy
```

The custom domain route (`tokens.lkwplus.com`) is declared in `wrangler.jsonc` and provisioned automatically on deploy. `workers_dev` is disabled, so the Worker is only reachable via the custom domain.

## Local development

```sh
npx wrangler d1 migrations apply tokens-usage --local
npm run dev
```

`wrangler dev` runs against a local D1 database. For the secret, put `TOKENS_API_TOKEN=...` in a `.dev.vars` file (gitignored).

Smoke test:

```sh
curl http://localhost:8787/api/health
curl -X POST http://localhost:8787/api/submit \
  -H "Authorization: Bearer $TOKENS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @sample-submission.json
curl "http://localhost:8787/api/stats?from=2026-07-01&to=2026-07-31"
```

## Project layout

```
src/index.ts             Worker entry: routing, auth, upsert + stats handlers
migrations/0001_init.sql D1 schema
wrangler.jsonc           Worker config (custom domain, D1 binding, observability)
```

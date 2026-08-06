#!/usr/bin/env bash
#
# Report the Codex subscription's rate-limit snapshot to POST /api/quota.
#
# `tokens codex status --json` asks ChatGPT's usage API using the local
# ~/.codex/auth.json, refreshing the OAuth token if it has expired. So the
# credential stays on this machine and the Worker only ever sees
# percentages and timestamps — see src/quota.ts for what it keeps.
#
# Runs on one host (OracleARM, which already runs `tokens serve`) under
# the systemd user timer beside this file. Quota is account-wide, so a
# second reporter would add nothing but a race.
#
# Silent on success, because a timer that logs every 30 minutes is a
# journal nobody reads. Any failure exits non-zero with a reason, which
# is what `systemctl --user status tokens-quota` will show.

set -euo pipefail

API_URL="${TOKENS_API_URL:-https://tokens.lkwplus.com}"
CREDENTIALS="${TOKENS_CREDENTIALS:-$HOME/.config/tokens/credentials.json}"

die() {
  echo "report-quota: $1" >&2
  exit 1
}

command -v tokens >/dev/null || die "the tokens CLI is not on PATH"

# The submit path's bearer token is the same one this endpoint takes, and
# the CLI already stores it — a second copy in the unit file would be a
# second thing to rotate.
[[ -r $CREDENTIALS ]] || die "no readable credentials at $CREDENTIALS"
token="$(jq -re '.token' "$CREDENTIALS")" || die "no .token in $CREDENTIALS"

# Captured before anything is sent: a failed fetch (expired refresh token,
# ChatGPT down) must leave the stored snapshot alone rather than overwrite
# it with an error string. `set -e` covers the exit code, and the emptiness
# check covers a success that returned nothing.
snapshot="$(tokens codex status --json)" || die "tokens codex status failed"
[[ -n $snapshot ]] || die "tokens codex status returned nothing"

curl --fail-with-body --silent --show-error \
  --retry 2 --retry-delay 5 --max-time 30 \
  --request POST "$API_URL/api/quota" \
  --header "Authorization: Bearer $token" \
  --header 'Content-Type: application/json' \
  --data-binary "$snapshot" \
  --output /dev/null

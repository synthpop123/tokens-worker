#!/usr/bin/env python3
"""Report the Claude subscription's rate-limit snapshot to /api/quota/claude.

Claude has no equivalent of `tokens codex status --json`, so this script
does what that command does for Codex: keep the OAuth credential alive
locally and ask the vendor. The credential never leaves this machine —
the Worker only ever sees percentages and timestamps.

The delicate part is the refresh. Anthropic **rotates the refresh token**
on every exchange: the old one dies the moment the new one is issued, so
losing the response means losing the login on this box entirely. Hence
the rules below.

  * Refresh only when the access token is actually near expiry. A working
    token is never traded in for a new one.
  * Write the new pair back before using it, atomically (temp file in the
    same directory, fsync, os.replace), so a crash mid-write leaves the
    previous credential intact rather than a truncated file.
  * Preserve every field the file already had. Claude Code stores more
    than tokens in there, and this script is a guest.

Standard library only: this runs on a box where the fewer moving parts
the better.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
# Claude Code's own OAuth client id; the refresh grant is issued to it.
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
SCOPE = (
    "user:profile user:inference user:sessions:claude_code "
    "user:mcp_servers user:file_upload"
)
# Refresh this far ahead of expiry, so a slow request cannot land after
# the token it was sent with has died.
REFRESH_MARGIN_S = 600
TIMEOUT_S = 30
# Every outbound request identifies itself. Cloudflare fronts the
# collector and answers the stdlib's default `Python-urllib/3.x` with a
# 403 (error 1010, a browser-signature ban), so this is load-bearing on
# the report leg, not decoration.
USER_AGENT = "tokens-quota-collector (+https://github.com/synthpop123/tokens-worker)"
# The vendor endpoints expect the client Claude Code presents.
VENDOR_USER_AGENT = "axios/1.15.2"

CREDENTIALS = Path(
    os.environ.get("CLAUDE_CREDENTIALS", Path.home() / ".claude" / ".credentials.json")
)
API_URL = os.environ.get("TOKENS_API_URL", "https://tokens.lkwplus.com").rstrip("/")
TOKENS_CREDENTIALS = Path(
    os.environ.get("TOKENS_CREDENTIALS", Path.home() / ".config" / "tokens" / "credentials.json")
)


def die(message: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"report-claude-quota: {message}", file=sys.stderr)
    raise SystemExit(1)


def post_json(url: str, payload: dict[str, Any], headers: dict[str, str]) -> Any:
    body = json.dumps(payload).encode()
    request = urllib.request.Request(
        url, data=body, method="POST", headers={"Content-Type": "application/json", **headers}
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        raw = response.read()
    return json.loads(raw) if raw else None


def read_credentials() -> tuple[dict[str, Any], dict[str, Any]]:
    """The whole file and the OAuth block inside it, kept separate so the
    rest of the file survives a write-back untouched."""
    try:
        stored = json.loads(CREDENTIALS.read_text())
    except FileNotFoundError:
        die(f"no credentials at {CREDENTIALS} — run `claude` on this host to log in")
    except (OSError, ValueError) as error:
        die(f"cannot read {CREDENTIALS}: {error}")
    oauth = stored.get("claudeAiOauth")
    if not isinstance(oauth, dict) or not oauth.get("accessToken"):
        die(f"{CREDENTIALS} has no claudeAiOauth.accessToken")
    return stored, oauth


def write_credentials(stored: dict[str, Any]) -> None:
    """Atomic replace, 0600, same directory (so it is the same filesystem
    and os.replace is a rename rather than a copy)."""
    directory = CREDENTIALS.parent
    handle, temp_path = tempfile.mkstemp(dir=directory, prefix=".credentials.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w") as file:
            json.dump(stored, file, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, CREDENTIALS)
    except BaseException:
        # A failed write must not leave a stray copy of a live credential.
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def refresh(stored: dict[str, Any], oauth: dict[str, Any]) -> str:
    refresh_token = oauth.get("refreshToken")
    if not refresh_token:
        die("access token expired and there is no refresh token — log in again on this host")

    try:
        granted = post_json(
            TOKEN_URL,
            {
                "client_id": CLIENT_ID,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "scope": SCOPE,
            },
            {"User-Agent": VENDOR_USER_AGENT, "Accept": "application/json"},
        )
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:200]
        die(f"token refresh failed ({error.code}): {detail}")
    except urllib.error.URLError as error:
        die(f"token refresh unreachable: {error.reason}")

    access_token = (granted or {}).get("access_token")
    if not access_token:
        die("token refresh returned no access_token")

    # The rotation: whatever came back replaces what we sent, and it is
    # persisted *before* the caller gets to use it. Anything the response
    # omitted keeps its previous value — this file belongs to Claude Code.
    oauth["accessToken"] = access_token
    if granted.get("refresh_token"):
        oauth["refreshToken"] = granted["refresh_token"]
    if granted.get("expires_in"):
        oauth["expiresAt"] = int((time.time() + float(granted["expires_in"])) * 1000)
    stored["claudeAiOauth"] = oauth
    write_credentials(stored)
    return access_token


def access_token() -> tuple[str, str | None]:
    """A usable access token, plus the subscription tier stored beside it
    (the usage endpoint does not report the plan's name)."""
    stored, oauth = read_credentials()
    expires_at = oauth.get("expiresAt")
    expired = (
        not isinstance(expires_at, (int, float))
        or expires_at / 1000 - time.time() < REFRESH_MARGIN_S
    )
    token = refresh(stored, oauth) if expired else oauth["accessToken"]
    plan = oauth.get("subscriptionType")
    return token, plan if isinstance(plan, str) and plan else None


def fetch_usage(token: str) -> dict[str, Any]:
    request = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": VENDOR_USER_AGENT,
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:200]
        die(f"usage request failed ({error.code}): {detail}")
    except (urllib.error.URLError, ValueError) as error:
        die(f"usage request failed: {error}")


def report(snapshot: dict[str, Any]) -> None:
    # The submit path's bearer token is the same one this endpoint takes,
    # and the tokens CLI already stores it — a second copy in the unit
    # file would be a second thing to rotate.
    try:
        token = json.loads(TOKENS_CREDENTIALS.read_text())["token"]
    except (OSError, ValueError, KeyError):
        die(f"no .token in {TOKENS_CREDENTIALS}")

    try:
        post_json(
            f"{API_URL}/api/quota/claude",
            snapshot,
            {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT},
        )
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:200]
        die(f"report rejected ({error.code}): {detail}")
    except urllib.error.URLError as error:
        die(f"collector unreachable: {error.reason}")


def main() -> None:
    token, plan = access_token()
    snapshot = fetch_usage(token)
    # The tier is not in the usage response, so it rides along from the
    # credential; the Worker decides whether it wants it.
    if plan:
        snapshot["plan"] = plan
    report(snapshot)


if __name__ == "__main__":
    main()

# Reporting hosts — how each one runs the CLI

Three machines run `tokens serve` against this Worker, and **no two of them
install or supervise it the same way**. Nothing about a host's setup is
discoverable from the Worker, so this file is the record. Hosts are named by
the `devices[].name` in `/api/site` — that display name is the only stable
identity a reader has, since internal device ids never leave the Worker.

One glance at what the fleet is actually running:

```sh
curl -s https://tokens.lkwplus.com/api/site \
  | jq -r '.devices[] | "\(.name)\t\(.cliVersion)\t\(.lastSeen/1000 | strflocaltime("%F %R"))"'
```

Every host points at `TOKENS_API_URL=https://tokens.lkwplus.com` and reads its
bearer token from the CLI's own `~/.config/tokens/credentials.json`, never from
a unit file or plist — one thing to rotate, per host.

## MacbookPro — macOS, arm64

| | |
|---|---|
| Install | Homebrew tap `owo-network/brew`, formula `tokens` → `/opt/homebrew/bin/tokens` |
| Supervisor | **Hand-written LaunchAgent**, `~/Library/LaunchAgents/com.lkw123.tokens-serve.plist` (label `com.lkw123.tokens-serve`) |
| Env | `TOKENS_API_URL`, `TOKENS_SUBMIT_INTERVAL=30` |
| Device name | `~/.config/tokens/device.json` → `name` |
| Logs | `~/Library/Logs/tokens-serve.log` |

Upgrade:

```sh
brew update && brew upgrade tokens
launchctl kickstart -k gui/501/com.lkw123.tokens-serve   # 501 = the login uid
```

**`brew services` does not manage this host.** The formula ships a `service`
block, but the agent in use is the hand-written plist, so `brew services list`
reports `tokens none` while `serve` is running perfectly well. Check
`launchctl print gui/501/com.lkw123.tokens-serve` instead, and never "fix" the
`none` by starting the brew service — that would give the machine two
reporters.

**The plist deliberately points at `/opt/homebrew/opt/tokens/bin/tokens`**, the
version-independent symlink, so an upgrade needs no plist edit. It does need
the `kickstart`: replacing the binary leaves the running process on the old
inode, so a skipped restart shows up as a host whose `cliVersion` never moves.

**The tap lags upstream, and that is this host's usual reason for being
behind.** On 2026-08-21 upstream `missuo/tokens` was at v27.0.4 while
`owo-network/brew` still pinned 27.0.2, so `brew upgrade` was a no-op and this
was the only host not on the current release. Wait for the tap rather than
dropping a binary into the Cellar by hand — Homebrew still believes the old
version is installed, and the next `brew upgrade` silently reverts it.

## OracleARM — Oracle Cloud, aarch64, Ubuntu

Getting in: `ssh arm` lands as **root**; everything tokens-related belongs to
the unprivileged **`agent`** user (uid 1002), so `su - agent` first.

| | |
|---|---|
| Install | Release tarball unpacked by hand to `/usr/local/bin/tokens` (root-owned), previous binary kept alongside as `tokens.<version>.bak` |
| Supervisor | systemd **user** units under `agent`: `tokens-serve.service`, plus the two quota timers |
| Env | `TOKENS_API_URL`, `TOKENS_DEVICE_NAME=OracleARM`, `TZ=Asia/Shanghai` |
| Device name | From `TOKENS_DEVICE_NAME` — *unlike* MacbookPro, which takes it from `device.json` |

Upgrade (as root for the binary, as `agent` for the restart):

```sh
V=27.0.4
curl -fsSL "https://github.com/missuo/tokens/releases/download/v$V/tokens-v$V-aarch64-unknown-linux-gnu.tar.gz" | tar xz -C /tmp
cp -a /usr/local/bin/tokens "/usr/local/bin/tokens.$(/usr/local/bin/tokens --version | awk '{print $2}').bak"
install -m755 /tmp/tokens /usr/local/bin/tokens
su - agent -c 'XDG_RUNTIME_DIR=/run/user/1002 systemctl --user restart tokens-serve'
```

**`systemctl --user` over `su - agent` needs `XDG_RUNTIME_DIR=/run/user/1002`
set by hand** — `su -` does not create the session bus variable, and without it
every `--user` command fails with a connection error that looks like the units
are gone. They are not.

**`loginctl enable-linger agent` is load-bearing.** The units are user units
but nobody logs in as `agent`; linger is what keeps them running after the root
ssh session ends, and it is already on.

Same restart rule as the Mac, and this host has the worked example: the binary
was replaced at 13:36 on 2026-08-21 and the service only picked it up at 14:50,
when it was restarted.

This is also the one host that reports subscription quota (two more user
timers) — that half is documented in the README's *Quota collection*, including
why exactly one host may do it.

## UbuntuPC

Not yet documented. Known from `/api/site` only: it reports as `UbuntuPC`, was
on CLI 27.0.4 on 2026-08-21, and submits on the usual cadence. Fill in access,
install method, and supervisor when next on that machine.

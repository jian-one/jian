# Jian

Jian is a same-origin Rust + React terminal workspace for local and remote
hosts. Use Local Bash, the Codex integration, or reusable generic command
configurations from one browser interface.

## Build and version

```sh
./build.sh                  # increment patch version, build UI, install jian and jian-client
./build.sh --keep-version   # build without changing x.y.z
./build.sh -kv
./build.sh --version 0.3.0  # select an exact version
```

`build.sh` keeps `Cargo.toml`, `frontend/package.json`, and
`frontend/package-lock.json` in sync. It restores the previous version if the
build or install fails. Binaries are installed under
`${CARGO_HOME:-$HOME/.cargo}/bin`.

## Run and deploy the server

```sh
JIAN_ADMIN_PASSWORD='change-me-now' jian serve
jian deploy
jian start
jian status
```

The server listens on `0.0.0.0:8080` by default. Set `bind_ip` and
`listen_port` in `~/.local/jian/config.json` to change it. `jian deploy` writes
the systemd user unit and environment under `~/.local/jian` and
`~/.config/systemd/user/jian.service`; run it from the repository or set
`JIAN_SOURCE_DIR`. Set `JIAN_ADMIN_USER`, `JIAN_ADMIN_PASSWORD`, or `JIAN_DB`
to configure account and storage defaults. The production UI is embedded from
`web/dist`.

## Register a remote host

1. Open **设置 → 远程主机**, enter a host name, and register it.
2. Install Jian on that host and run the one-time command shown by the UI:

   ```sh
   cargo install --path . --locked --bin jian-client
   jian-client connect --server https://jian.example --host HOST_ID --token TOKEN
   ```

3. Leave `jian-client` running. It reconnects after network interruptions.
   The host appears as online, and its home directory is available in the
   workspace picker.

Use HTTPS in deployed environments so the client uses WSS and its bearer token
is encrypted in transit. Jian stores only the token hash. The registration
token is shown once; rotate it to revoke the previous client. Removing a host
revokes its connection and removes its remote sessions.

The client owns the remote PTYs. A browser disconnect only detaches the
display; the client keeps terminal output for replay after reconnect. Run the
client under the process manager used by that host if it should start
automatically. `jian deploy` manages only the Jian server service.

## Launchers and sessions

Codex native thread discovery uses the local `codex app-server --stdio`
protocol. New local sessions use a server-owned Bash PTY. Remote Codex starts
`codex` on the selected host. Set `JIAN_CODEX_BIN` when the local Codex binary
is not on the server user's `PATH`; remote clients resolve `codex` on their
own host.

The **通用启动器** settings let you define named commands with a program,
separate argv entries, and environment variables. These configurations are
shared by all Jian users and can run locally or on an online remote host.
Arguments are passed directly to the program without shell interpolation.

Set `JIAN_BASH_BIN` to override the local Bash executable; it defaults to
`/bin/bash`.

## Codex quota API

`GET /api/agents/codex/rate-limits` requires a Jian login cookie and returns
the complete JSON result from Codex `account/rateLimits/read`, including
`rateLimits`, `rateLimitsByLimitId`, credit details, and
`rateLimitResetCredits` when available. Unknown fields are preserved.
Unauthenticated requests return HTTP 401; unavailable Codex, account, or
upstream quota data returns HTTP 503 with `{"error":"..."}`.

Codex session headers on desktop, mobile, and split terminals share a quota
snapshot, refreshed every 30 seconds while the page is visible and immediately
when it becomes visible again. `Reset` is
`rateLimitResetCredits.availableCount`, not a reset timestamp. Missing fields
display `—`; failed reads display `额度暂不可用`.

## Development checks

```sh
cargo test
npm --prefix frontend run test:input
npm --prefix frontend run test:session
npm --prefix frontend run test:layout
npm --prefix frontend run build
```

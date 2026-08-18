# Jian

Jian is a small, same-origin Rust + React workspace for Codex and Hermes
agents.

## Deploy and manage the user service

```sh
./build.sh
jian deploy
jian start
jian stop
jian restart
jian status
jian log
jian log -f
```

`build.sh` builds the UI and installs the `jian` binary with Cargo under
`${CARGO_HOME:-$HOME/.cargo}/bin`. The `deploy` subcommand only writes the systemd user
unit, reloads and enables it, then restarts the service. It stores application data under
`~/.local/jian` and manages
`~/.config/systemd/user/jian.service`. Run it from the repository, or
set `JIAN_SOURCE_DIR` to the repository path. The service listens on
`0.0.0.0:8080` by default. Optional administrator and Hermes settings can be
placed in `~/.local/jian/env`. The file is created with development
defaults on the first deploy and is never overwritten on subsequent deploys.


## Run locally

```sh
cd frontend && npm install && npm run build
cd ..
JIAN_ADMIN_PASSWORD='change-me-now' cargo run
```

The server listens on `0.0.0.0:8080`. Set `bind_ip` and `listen_port` in
`~/.local/jian/config.json` to change it. Set `JIAN_ADMIN_USER`,
`JIAN_ADMIN_PASSWORD`, or `JIAN_DB` to adjust those defaults. The production
UI is embedded from `web/dist`.

## Codex terminal integration

Jian discovers native Codex threads through the local `codex app-server`
stdio protocol. Each active session is run by a backend-owned Bash process and
PTY; the browser only displays the stream and forwards terminal input. Browser
refreshes and WebSocket disconnects only detach the display, while buffered
output is replayed on reconnect. Stopping or deleting a session terminates its
Bash process group and the Agent child.

Set `JIAN_CODEX_BIN` to an absolute executable path when Codex is not on
the service user's `PATH`; place it in the service environment file so the
systemd service can use it.

## Hermes chat integration

When Hermes is available, Jian exposes an interactive xterm.js workspace
backed by a per-session Bash process running the Hermes CLI through a PTY. Set
`JIAN_HERMES_BIN` when the `hermes` command is not on the service user's
`PATH`. Profiles are configured with a comma-separated
`JIAN_HERMES_PROFILES` value (for example `default,swork`). If it is
omitted or empty, Jian uses `default` plus every profile directory under
`$JIAN_HERMES_HOME/profiles`. Jian directly runs `hermes -p <profile> sessions
list --limit 10000` whenever it loads the session list, so the browser shows
the same native sessions as the Hermes CLI.

Hermes sessions are resumed through the CLI in a server-owned PTY and survive
browser reconnects while the server process remains alive. Jian does not start
or depend on an Hermes ACP process.

Set `JIAN_BASH_BIN` to override the Bash executable used for session
terminals; it defaults to `/bin/bash`.

For a user service, put these variables in
`~/.local/jian/env` (the recommended persistent location), or
export them before running the server/deploy script:

```sh
JIAN_HERMES_BIN=/home/gaofei/.local/bin/hermes
JIAN_HERMES_HOME=/home/gaofei/hermes
# Leave unset or empty to discover all profiles.
# JIAN_HERMES_PROFILES=default,swork
```

```sh
cargo test
cd frontend && npm run build
```

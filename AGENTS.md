# Jian

Code navigation starts with `codegraph_codegraph_explore`; a `.codegraph/`
index is present. Treat returned source as already read and use text search to
fill gaps.

## Project purpose

Jian is a cookie-authenticated browser workspace for local and remote terminal
sessions. The Rust server owns local PTYs and relays browser input/output to
registered remote clients. The React UI manages the catalog and attaches to a
terminal; a browser connection never owns a process.

Core capabilities:

- Create local Bash and Codex sessions, plus sessions from reusable generic
  command configurations.
- Register remote hosts. A `jian-client` process connects back to Jian and
  opens PTYs on that host; browser sessions can target either the local server
  or an online registered host.
- Discover local native Codex threads through `codex app-server --stdio`.
  Normal catalog reads use the runtime cache; explicit refresh performs native
  discovery. Generic command sessions and remote sessions are server-owned
  catalog records.
- Attach xterm.js over an authenticated, same-origin WebSocket. Browser
  disconnects detach the display while the host keeps the PTY and bounded
  output buffer for reconnect replay.
- Persist users, login sessions, shared launcher settings, registered-host
  token hashes, remote session records, recent workspaces, audit events,
  runtime state, and monitor definitions in a private BoltDB database.
- Build the Vite frontend into `web/dist` and embed it in the server. `jian`
  manages the server service; `jian-client` runs on remote hosts.

## Repository map

- `src/main.rs` wires server configuration, authentication, HTTP/WebSocket
  routes, host registration, session routing, embedded assets, and the `jian`
  administration CLI.
- `src/model.rs` contains shared agent, session, event, and configuration
  types. `AgentKind` supports `codex`, `command`, and `local`; Local is a
  terminal area and does not represent a configurable agent.
- `src/runtime.rs` owns local Codex and generic command launchers, local Bash,
  and native Codex discovery.
- `src/remote.rs` tracks connected clients and routes PTY commands and events.
- `src/bin/jian-client.rs` is the remote host client. It reconnects to Jian,
  owns remote PTYs, and keeps bounded output for reconnect replay.
- `src/terminal.rs` owns local PTY process lifecycle, subscribers,
  restart/release operations, and active/inactive pooling.
- `src/store.rs` is the BoltDB-compatible persistence layer. `Store::open`
  creates buckets and keeps database permissions private.
- `frontend` is the Vite + React application; see
  [`frontend/AGENTS.md`](frontend/AGENTS.md) for frontend rules.
- `web/dist` is generated output embedded by `rust-embed`. Never edit it by
  hand.
- `build.sh` builds and installs both binaries. `jian deploy` manages the
  server service; it does not install a remote client service.

## Architecture and invariants

- Codex is the only specialized agent adapter. Other CLIs use shared
  `CommandConfig` records with a program, argv list, and environment variables.
  Adding a specialized adapter requires coordinated model, runtime, HTTP,
  frontend, and test changes.
- Build process commands with argv; never interpolate user input into shell
  strings. Generic command configuration intentionally permits administrators
  to launch arbitrary programs.
- Local sessions run as server-owned PTYs. Remote sessions run as
  `jian-client`-owned PTYs and are addressed by session ID through the server
  relay. Keep those process owners explicit in lifecycle changes.
- Preserve same-origin origin checks, cookie authentication for browser APIs,
  bearer-token authentication for remote clients, reconnect buffering, and
  process ownership. Persist only a hash of each remote client token.
- Stop, delete, and release operations terminate the PTY process and its child
  processes where the platform provides process-group control.
- Canonicalize local workspace paths before launch. Remote paths are interpreted
  on the selected host. Treat paths, terminal input, CLI output, and
  agent-provided metadata as untrusted.
- Missing Codex executables are a supported degraded mode: report a clear
  unavailable response without preventing server startup.
- The local terminal manager's active/inactive pool and status/release/restart
  endpoints are operational controls. Preserve their synchronization and
  lifecycle semantics.

## Development workflow

Prerequisites are stable Rust and Node/npm. Codex is optional for live local
integration work; `jian-client` can build without installed agent CLIs.

```sh
# Backend tests
cargo test

# Frontend focused checks
npm --prefix frontend run test:input
npm --prefix frontend run test:session
npm --prefix frontend run test:layout

# Build embedded frontend assets after frontend changes
npm --prefix frontend run build

# Run locally
JIAN_ADMIN_PASSWORD='change-me-now' cargo run -- serve

# Build and install both binaries; default build increments patch version
./build.sh
./build.sh --keep-version
./build.sh --version 0.3.0
```

Useful server settings include `JIAN_DB`, `JIAN_ADMIN_USER`,
`JIAN_ADMIN_PASSWORD`, `JIAN_SECURE_COOKIE`, `JIAN_CODEX_BIN`, `CODEX_BIN`,
`JIAN_BASH_BIN`, and `JIAN_SOURCE_DIR`. Remote command programs are resolved
on the remote host; remote Codex uses `codex` from that host's PATH.

Remote clients should connect through HTTPS/WSS in deployed environments so
their registration token is protected in transit. Run the generated
`jian-client connect` command in the remote host process manager appropriate
for that host; Jian does not create remote services automatically.

`jian deploy` writes the server unit and environment under the user's XDG-style
Jian/systemd locations. It uses the repository at the current directory or
`JIAN_SOURCE_DIR`. Do not hand-edit generated `web/dist` assets or commit local
databases, service environment files, or `frontend/node_modules`.

Run `cargo fmt` on modified Rust files. Add focused tests for host registration,
authentication, remote routing, settings persistence, catalog behavior,
terminal lifecycle, and command construction. Unit tests must not require
installed external agent CLIs; use temporary fixtures and existing seams.

## Frontend scope

For any work inside `frontend/`, read and follow
[`frontend/AGENTS.md`](frontend/AGENTS.md). Radix UI primitives are mandatory
when an appropriate primitive exists. Keep API paths and WebSocket semantics
aligned with `src/main.rs`, and rebuild `web/dist` after frontend changes
intended for deployment.

## Change discipline

- Prefer cohesive changes that preserve the separation between HTTP, local
  runtime adapters, remote-client relay, terminal lifecycle, storage, and
  frontend state.
- Preserve unavailable-Codex behavior and remote-session records whose host is
  temporarily offline.
- Preserve unrelated dirty worktree changes. Never overwrite user-provided
  edits or generated output except through the requested frontend build.
- Never commit credentials, local databases, generated transient files,
  service environment files, or `frontend/node_modules`.

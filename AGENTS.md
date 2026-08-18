# Jian

## Project purpose

Jian is a same-origin, cookie-authenticated browser workspace for local Bash,
Codex, and Hermes sessions. It is deliberately a thin control plane: the Rust
server owns processes and their terminal state; the React UI displays the
catalog and proxies terminal input.

Core capabilities:

- Create and manage server-owned local Bash PTYs, plus Codex and Hermes agent
  sessions in a selected workspace. Hermes sessions are scoped to a profile.
- Discover native Codex threads through its app-server protocol and native
  Hermes sessions through the Hermes CLI. The runtime manager keeps an
  in-memory cache; normal listing reads that cache and explicit refreshes run
  native discovery.
- Attach xterm.js over an authenticated, same-origin WebSocket. A browser
  disconnect only detaches the display: the PTY continues and its bounded
  output buffer is replayed when a client reconnects.
- Keep active and inactive terminal pools. Idle, unsubscribed, non-busy
  terminals move to the inactive pool; the next sweep releases that pool.
- Persist users, login sessions, user-specific agent settings, recent
  workspaces, audit events, runtime state, and monitor definitions in a
  private BoltDB database. Native-agent discovery data and live PTYs are not
  authoritative BoltDB records.
- Build the Vite frontend into `web/dist` and embed it in the Rust server; the
  `jian` CLI installs and manages the systemd user service.

## Repository map

- `src/main.rs` wires configuration, authentication, HTTP/WebSocket routes,
  embedded assets, and the `jian` administration CLI.
- `src/model.rs` contains shared agent, session, event, and message types.
  `domain.AgentKind` intentionally contains only `codex` and `hermes`; local
  Bash is a terminal label/UI area, not an agent kind.
- `src/runtime.rs` contains Codex, Hermes, local-Bash integration, and native
  session discovery. Keep native CLI work out of normal list requests.
- `src/terminal.rs` owns PTY process lifecycle, buffered output,
  subscribers, restart/release operations, and active/inactive pooling.
- `src/store.rs` is the BoltDB-compatible persistence layer. `Store::open` creates the
  buckets, migrates away the legacy session snapshot bucket, and keeps data
  permissions private.
- `frontend` is the Vite + React source application; see
  [`frontend/AGENTS.md`](frontend/AGENTS.md) for mandatory frontend rules.
- `web/dist` is generated frontend output embedded by `rust-embed`. Never
  edit it by hand.
- `build.sh` builds the frontend and installs the `jian` CLI. Deployment is
  performed by `jian deploy`, not by a `deploy.sh` script.

## Architecture and invariants

- Codex and Hermes are the only supported `domain.AgentKind` values. Adding an
  agent requires coordinated domain, runtime-manager, HTTP API, frontend, and
  test changes.
- Codex uses `codex app-server --stdio` for thread discovery/creation and the
  Codex CLI in a Bash-backed PTY for interactive work and resume.
- Hermes does **not** use ACP. It discovers and manages native sessions by
  invoking the Hermes CLI per configured profile, and its interactive UI is a
  Bash-backed PTY. Do not reintroduce an ACP process or document one.
- Local sessions are also server-owned Bash PTYs. Their launch profiles and
  agent executable paths/arguments are per-user settings; preserve that scope
  when changing settings or runtime replacement.
- A browser WebSocket never owns a process. Preserve same-origin origin checks,
  cookie authentication, reconnect buffering, and server ownership for every
  terminal endpoint.
- Stop, delete, and terminal-release operations must terminate the PTY process
  group so agent children do not survive their session. Build process commands
  with argv; never interpolate untrusted input into shell strings.
- API endpoints under `/api/` require the authentication middleware, except
  the authentication endpoints. Workspace paths are canonicalized to absolute,
  clean paths before starting a session. Treat paths, terminal input, CLI
  output, and agent-provided metadata as untrusted input.
- Native Codex sessions cannot be renamed. Hermes native identity is
  `(kind, profile, native ID)`. Keep compatibility for imported/native sessions
  that have no server-owned terminal.
- Missing Codex or Hermes executables are a supported degraded mode: return a
  clear unavailable response without preventing server startup.
- The terminal manager's active/inactive pool and its status/release/restart
  endpoints are operational controls, not a replacement for session discovery.
  Preserve their synchronization and process-group lifecycle semantics.

## Development workflow

Prerequisites are stable Rust, Node/npm, and optionally the `codex` and `hermes`
CLIs for live integration work.

```sh
# Backend tests
cargo test

# Frontend unit/guard checks
npm --prefix frontend run test:input
npm --prefix frontend run test:session
npm --prefix frontend run test:layout

# Build the embedded frontend after frontend changes
npm --prefix frontend run build

# Run locally (use a real password outside development)
JIAN_ADMIN_PASSWORD='change-me-now' cargo run

# Install the CLI and manage the user service
./build.sh
jian deploy
jian status
```

Useful settings include `JIAN_DB`, `JIAN_ADMIN_USER`,
`JIAN_ADMIN_PASSWORD`, `JIAN_SECURE_COOKIE`, `JIAN_CODEX_BIN`, `CODEX_BIN`,
`JIAN_HERMES_BIN`, `HERMES_BIN`, `JIAN_HERMES_HOME`, `HERMES_HOME`,
`JIAN_HERMES_PROFILES`, `JIAN_BASH_BIN`, and `JIAN_SOURCE_DIR`.

`jian deploy` writes the user service and its environment file under the
user's XDG-style Jian/systemd locations. It uses the repository at the current
directory or `JIAN_SOURCE_DIR`. Do not hand-edit generated `web/dist` assets
or commit local databases, service environment files, or `frontend/node_modules`.

Run `cargo fmt` on modified Rust files. Add or update focused Rust tests for HTTP
handlers, catalog/cache behavior, persistence, authentication, terminal
pool/lifecycle behavior, and runtime command construction. Unit tests must not
require installed external agent CLIs; use the existing seams and temporary
fixtures.

## Frontend scope

For any work inside `frontend/`, read and follow
[`frontend/AGENTS.md`](frontend/AGENTS.md). It takes precedence for frontend
implementation and design choices. In particular, Radix UI primitives are
mandatory whenever an appropriate primitive exists. Keep API paths and
WebSocket semantics aligned with `src/main.rs`, and rebuild `web/dist`
whenever frontend source changes are meant for deployment.

## Change discipline

- Prefer small, cohesive changes that preserve the separation between HTTP,
  runtime adapters, terminal lifecycle, storage, and frontend state.
- Preserve compatibility paths for native/imported sessions and unavailable
  agents unless a tested change deliberately removes them.
- Preserve unrelated work in a dirty worktree. Do not overwrite user-provided
  files or generated output except when the requested frontend build creates
  it.
- Never commit credentials, local databases, generated transient files, or
  `frontend/node_modules`; treat service credentials and environment files as
  sensitive.

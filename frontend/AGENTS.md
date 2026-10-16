---
name: jian-frontend
description: Implementation and visual-design rules for Jian's React frontend.
---

# Jian frontend

Jian is an authenticated local and remote terminal workspace, not a generic
dashboard. Its main job is to let a user choose a Local Bash, Codex, or generic
command session, then operate its long-lived terminal without obscuring host
and process state. The UI should feel calm, precise, and operationally
trustworthy.

## Mandatory component policy: Radix UI first

`radix-ui` is already installed and is the required first choice for
interactive UI primitives. This is a hard requirement, not a styling
preference.

- When Radix provides an appropriate primitive, use it. This includes dialogs,
  alert/confirmation flows, menus, dropdowns, popovers, selects, navigation
  menus, tabs, tooltips, checkboxes, switches, accordions, context menus,
  scroll areas, and toast-like transient feedback.
- Import primitives from `radix-ui` and compose/style them with Jian's CSS.
  Radix supplies interaction and accessibility behavior; it does not require a
  prebuilt visual theme.
- Do not hand-roll modal portals, focus traps, Escape handling, outside-click
  dismissal, roving keyboard navigation, menu semantics, or ARIA equivalents
  for a control that Radix already supports. Do not add a competing component
  library for these primitives.
- A native HTML control is appropriate for simple form fields and buttons. A
  custom interaction is allowed only when Radix has no suitable primitive; keep
  it small, keyboard-accessible, and document the reason near the component.
- Preserve controlled `open`/`value` state at the existing owner. Do not let a
  Radix primitive and ad-hoc DOM code compete to control focus or dismissal.

Existing examples to follow are `ConfirmDialog` (Radix Dialog) and
`SidebarNavigation` (Radix Navigation Menu). When converting an existing
custom interaction, prefer replacing its behavior with the relevant primitive
instead of wrapping it in extra imperative event listeners.

## Current frontend structure

- `src/main.tsx` is the composition root and currently owns authentication,
  session loading/refresh guards, selected area, tabs, terminal attachment,
  workspace and host selection, and top-level dialogs. Keep changes
  compatible with its persisted local-storage keys and async-load guards.
- `src/features/auth` contains login; `features/navigation` owns the sidebar;
  `features/session-catalog` owns session rows and rename/delete UI;
  `features/terminal` mounts xterm.js; `features/settings` owns the settings
  page.
- `src/shared/api.ts` is the authenticated JSON request helper.
  `src/shared/model.ts` holds client API types; `src/shared/persistence.ts`
  owns browser cache/persistence; `src/shared/ui` holds reusable composed UI,
  including Radix-based components and agent icons.
- `src/styles.css` holds the visual system and component styles;
  `src/layout.css` holds responsive/layout overrides. Preserve that split and
  avoid inline style sprawl.
- `public/` holds PWA assets and agent icons. `web/dist` is generated output
  embedded by Rust and must only change through `npm run build`.

## API, terminals, and state boundaries

- Use paths relative to `/api` through the shared API helper. Keep them aligned
  with `src/main.rs`; do not invent frontend-only endpoints.
- xterm.js connects to the same-origin, cookie-authenticated terminal WebSocket
  endpoints. The browser is a subscriber, never the process owner. A terminal
  can reconnect and receives replayed output, so do not equate socket close
  with agent/session termination.
- The three visible areas have different identities: `local` is a server-owned
  Bash-terminal area, `codex` is the specialized agent, and `command` selects
  a reusable generic launcher configuration. A session may run locally or on
  a registered remote host.
- Host registration and command configuration are shared server settings.
  Display remote host identity and connection state when creating or managing
  sessions; do not treat a remote workspace path as a local server path.
- Session responses may represent a native session with no active PTY. Keep
  status, reconnect, stop/delete, release, and restart actions distinct.
- Shared server settings control launcher paths, command presets, launch
  arguments, and launcher visibility. Do not replace them with browser-only
  state.
- Treat all API text (session titles, workspaces, host names, errors, and terminal
  output) as untrusted. Render text normally; never use raw HTML injection.

## Design and interaction quality

- Ground new UI in Jian's task: a person is managing real local processes.
  Favor clear state, direct verbs, stable session identity, and readable
  workspace/host context over decorative dashboard patterns.
- Follow the existing visual language before introducing a new one. Make one
  deliberate visual choice only when the task calls for it; do not add generic
  gradients, ornamental statistics, or animation just to fill space.
- Style Radix data attributes and state (`data-state`, focus-visible, disabled)
  so hover, keyboard focus, selected, busy, error, empty, and disconnected
  states are all visible.
- Maintain responsive behavior, keyboard access, and `prefers-reduced-motion`.
  Terminal focus must not steal focus from an open modal or settings control.
- Write concise Chinese UI copy in the established product voice. Labels name
  the user's action; confirmations and errors state the result and recovery
  path plainly.

## Verification

After frontend changes, run the checks relevant to the edit:

```sh
npm run test:input
npm run test:session
npm run test:layout
npm run build
```

Run the commands from `frontend/` (or use `npm --prefix frontend run ...` from
the repository root). Build after source changes intended for deployment so
the embedded `web/dist` matches the source. Do not edit generated files or
`node_modules` manually.

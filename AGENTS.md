# AGENTS.md

Guidance for agents working in this repository.

## What this is

`plane-llamacpp` (`plane-llamacpp@wfelipe.com`) is a **GNOME Shell 50 extension**
that adds a configurable custom command menu to the top bar, written in
TypeScript and compiled to GJS-compatible JavaScript. It is NOT a Node/web app —
there is no runtime `node`; the compiled output is loaded by GNOME Shell's GJS
runtime. The feature set is ported from
[StorageB/custom-command-menu](https://github.com/StorageB/custom-command-menu).

Read [README.md](./README.md) first; it documents the features, project
structure and build flow.

## Build / lint / format

Uses **pnpm**. Toolchain commands:

```bash
pnpm install        # install deps
pnpm run build      # tsc -> dist/ (this is the only "test"-like gate)
pnpm run lint       # eslint .
pnpm run format     # prettier --write .
pnpm run setup      # build + pack + install (full local deploy)
```

Make targets wrap the same flow: `make` / `make pack` / `make install` /
`make clean`. `make pack` requires the system `zip`, `glib-compile-schemas`,
and `gnome-extensions` binaries — these are distro packages, not npm deps.

**There is no test runner in this repo.** Treat `pnpm run build` (tsc typecheck)
and `pnpm run lint` as the correctness gates.

## Architecture & layer rules

The project intentionally keeps a **flat layout** (in the spirit of small
extensions like Custom Command Menu). All sources live at the repo root:

- **Entry points**: GNOME Shell loads `extension.js` and `prefs.js`, which `tsc`
  emits directly from the root `.ts` files.
  - `extension.ts` — the panel `CommandMenu` (`PanelMenu.Button` subclass, built
    via `build(settings)`) **and** `PlaneLlamacppExtension` (`enable`/`disable`
    lifecycle, rebuilds the indicator on a debounced `changed::` signal).
  - `prefs.ts` — `PlaneLlamacppPreferences`: the Configuration page
    (backup/restore, menu settings, about) plus the maximize-button helper.
  - `commandsUI.ts` — `commandsUI` (`Adw.PreferencesPage`): the command editor
    with per-row entries, visibility checkbox, insert/duplicate/delete actions
    and drag-and-drop reordering.
  - `about.ts` — the `releaseNotes` string.

- Internal imports MUST use the `.js` extension (e.g.
  `import commandsUI from './commandsUI.js';`) even though the source is `.ts` —
  GJS/tsc resolve it at runtime, and the compiled files sit flat in `dist/`.

- The two processes (Shell `extension.js` and GTK `prefs.js`) only communicate
  through GSettings. Settings keys are referenced as plain strings next to their
  use; the schema
  `schemas/org.gnome.shell.extensions.plane-llamacpp.gschema.xml` defines the
  menu keys plus `command1`..`command99` (`(sssb)` = name, command, icon,
  visible) and `command-order` (`ai`). Re-run `glib-compile-schemas schemas`
  (done automatically by `make pack`) after schema changes.

- `ambient.d.ts` is the GJS/GNOME Shell ambient type entry — keep it as the
  `tsconfig.json` `include`. New root `.ts` files must be added to the
  `tsconfig.json` `files` array AND to `TS_SOURCES` in the `Makefile`.

## Coding conventions

- **GNOME/GJS style** — follow the [GJS guide](https://gjs.guide).
  - TypeScript strict mode is on (`tsconfig.json`). Module: `NodeNext`.
  - GObject subclasses register via `GObject.registerClass` and build in `_init`
    (not `constructor`); custom per-widget metadata is typed via intersection
    types (see `CommandRow` in `commandsUI.ts`) rather than untyped property adds.
  - GNOME library imports use the `gi://` or `resource:///` schemes.
- **Formatting** (`.prettierrc.yml` / `.editorconfig`): 4-space indent, single
  quotes, semicolons, no bracket spacing, `arrowParens: avoid`, trailing comma
  `es5`, LF line endings. `Makefile` uses tabs.
- **ESLint**: `prefer-const`, `no-var`, `eqeqeq` are errors; unused vars are
  warnings. Prettier owns style; ESLint owns correctness.
- License header: source files carry an SPDX-License-Identifier line
  (`GPL-2.0-or-later`). Match the file's existing header style.

## GNOME Shell / GJS gotchas

- Target shell version is **50 only** (`metadata.json` `shell-version: ["50"]`).
  Type definitions are `@girs/gnome-shell@50` + `@girs/gjs@4`. Check the type
  defs under `node_modules/@girs/` when an API is uncertain.
- After installing an extension build, the user must **log out/in or restart the
  Shell** to pick up changes — there's no hot reload in normal use.
- Debugging/iteration: `pnpm run debug` starts `gnome-shell --devkit --wayland`
  via dbus-run-session.

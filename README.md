# plane-llamacpp

A GNOME Shell extension (`plane-llamacpp@wfelipe.com`) that adds a **custom
command menu** to the top bar: define display names and shell commands, reorder
them by drag and drop, group them into submenus, add separators and dynamic
labels, and run them with a click.

Written in TypeScript, following the official
[TypeScript and LSP](https://gjs.guide/extensions/development/typed.html) guide,
and organized with a **flat, simple layout** (in the spirit of small extensions
like Custom Command Menu). The full command-menu feature set is ported from
[StorageB/custom-command-menu](https://github.com/StorageB/custom-command-menu).

## Features

- Configurable drop-down menu of commands in the GNOME top bar.
- Per-entry name, shell command and (optional) symbolic icon.
- Drag-and-drop reordering; show/hide entries with a checkbox.
- **Separators**: enter `---` or `~~~` in the name field (add text after them for
  a labeled separator).
- **Submenus**: start a command name with `*`; the title comes from the row above.
- **Dynamic labels**: `$(command)` substitution inside names.
- Special command `##ShowApplications` opens the application overview.
- Menu type (default text / custom text / icon), location and position options.
- Import/export the command list to `~/commands.ini`, and reset to defaults.

## Project structure

```
plane-llamacpp/
├── extension.ts    # Panel menu (CommandMenu) + PlaneLlamacppExtension lifecycle
├── prefs.ts        # PlaneLlamacppPreferences (Configuration page, backup, about)
├── commandsUI.ts   # Adwaita page that edits the command list (drag & drop, etc.)
├── about.ts        # Release notes shown in the preferences window
├── ambient.d.ts    # GJS / GNOME Shell ambient type imports
├── schemas/        # GSettings schema (99 command slots + menu settings)
├── metadata.json   # GNOME Shell extension metadata
├── stylesheet.css  # Custom styling
├── tsconfig.json   # tsc config (NodeNext, outDir: dist)
├── Makefile        # build / pack / install targets
└── package.json    # pnpm scripts and dependencies
```

GNOME Shell loads `extension.js` and `prefs.js` from the extension root; `tsc`
compiles the root `.ts` files straight into `dist/` with matching names.

## Requirements

- GNOME Shell 50
- Node.js + [pnpm](https://pnpm.io)
- `tsc` (provided via `typescript` devDependency)
- `glib-compile-schemas`, `zip`, `gnome-extensions` (provided by your distro)
    - Arch: `sudo pacman -S glib2 zip gnome-shell`
    - Debian/Ubuntu: `sudo apt install libglib2.0-bin zip gnome-shell`
    - Fedora: `sudo dnf install glib2 zip gnome-shell`

## Install dependencies

```bash
pnpm install
```

## Build

Compile the TypeScript sources into `dist/`:

```bash
pnpm run setup

# ts -> js
pnpm run build
# or
make
```

## Pack and install

```bash
make pack      # generates plane-llamacpp@wfelipe.com.zip
make install   # installs it for the current user via gnome-extensions
make clean     # removes dist/, node_modules/ and the generated zip
```

After `make install`, log out and back in (or restart the Shell) to see the
extension in the Extension Manager.

## License

GPL-2.0-or-later — see [LICENSE](./LICENSE).

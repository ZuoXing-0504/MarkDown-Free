# CleanMark

CleanMark is a clean-room desktop Markdown editor built from scratch with
Electron. It does not import or execute Typora code, ASAR archives, V8 bytecode,
assets, or proprietary bridge implementations.

## Features

- Open, edit, save, and save-as for Markdown and text files
- Recursive Markdown file browser for opened folders
- Live split preview with GitHub-flavored Markdown and syntax highlighting
- Sanitized preview HTML using DOMPurify
- Editor, split, and preview layouts
- Light, dark, and system themes
- Document search, drag-and-drop opening, formatting helpers, and word count
- Optional debounced auto save
- Unsaved-change protection when replacing or closing a document

## Run

Requirements: Node.js 22 or newer and npm.

```powershell
npm install
npm start
```

## Windows installer

This project uses Electron Packager and Inno Setup 6.7 or newer. The installer
is per-user, requires no administrator privileges, uses the confirmed CleanMark
icon, and optionally adds CleanMark to the Windows Open With list for `.md` and
`.markdown` files.

```powershell
npm run installer:win
```

The output is `release/installer/清墨-0.2.1-安装程序.exe`. Generated release
artifacts are intentionally excluded from Git; publish the installer through a
GitHub Release instead.

If Electron's binary download is unavailable from the default host, install it
through an accessible mirror and start again:

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
node .\node_modules\electron\install.js
npm start
```

## Verify

```powershell
npm run check
npm run smoke
npm run test:e2e
```

`check` bundles the renderer and parses the Electron scripts. `smoke` launches a
hidden real Electron window and verifies renderer loading, the sandbox bridge,
IPC file reading/writing, Markdown rendering, and removal of script elements
from preview HTML. `test:e2e` creates real Markdown files under `test-results`,
then opens, edits, saves, saves-as, reopens, auto-saves, filters, renders, and
validates them in Electron. See `COMPARISON.md` for the measured feature gap.

## Architecture

```text
electron/main.cjs
  Window, menus, dialogs, bounded file I/O, folder scanning
           |
           | Electron IPC
           v
electron/preload.cjs
  Narrow contextBridge API; no generic IPC exposure
           |
           v
src/renderer.js
  Editor state, Markdown rendering, UI interactions
```

The renderer uses `contextIsolation`, Electron sandboxing, disabled Node
integration, a restrictive Content Security Policy, sanitized preview output,
and an allowlist for external URL protocols. File size and folder scan limits
avoid accidentally loading unbounded input.

## Project layout

- `electron/main.cjs`: Electron main process and native operations
- `electron/preload.cjs`: isolated renderer API
- `src/index.html`: application structure and CSP
- `src/styles.css`: responsive light/dark interface
- `src/renderer.js`: document model, preview, sidebar, and commands
- `scripts/build.mjs`: esbuild renderer bundle
- `assets/icon`: SVG master, PNG sizes, and Windows ICO
- `installer/cleanmark.iss`: Chinese per-user Inno Setup installer
- `dist`: generated runtime assets; do not edit directly

## Current scope

This first version intentionally stays small. It does not yet provide tabs,
image asset management, PDF export, Mermaid, math rendering, recovery snapshots,
or packaged installers. Those can be added as independent features without
depending on proprietary code.

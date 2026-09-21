# Desktop app (Linux)

The desktop app is Agentry in a window: the same UI and REST API as the Docker image, packaged as
an AppImage and a `.deb` for Linux x86_64. No container, no port to remember.

It is a small Electron shell. On start it launches the bundled API as a child process on
`127.0.0.1` with a free port, waits for it to come up and loads the UI. The API runs on the Node
that ships inside Electron, so **you do not need Node installed**. Quitting the window stops the
server.

## How it differs from Docker

| | Docker image | Desktop app |
| --- | --- | --- |
| Where Claude runs | Inside the container | On your machine, as you |
| Sandbox | The container | **None** |
| Default permission mode | `bypassPermissions` | `acceptEdits` |
| Claude Code CLI | Baked into the image | Yours, from your `PATH` |
| Login | `CLAUDE_CODE_OAUTH_TOKEN` | Your existing `~/.claude` login |
| Listens on | `0.0.0.0:8787` | `127.0.0.1`, random port |

The image can afford `bypassPermissions` because the container is the boundary. The desktop app has
no boundary: Claude reads and writes your real files and runs commands with your privileges. So it
starts in `acceptEdits`, where file edits are applied and anything else that needs permission is
sent to the panel for you to allow or deny. A run can still choose another mode from the UI.

Authentication is off by default (see [SECURITY.md](../SECURITY.md)). The desktop server only
listens on the loopback interface, but any process on your machine can reach that port. Turn on a
token in Settings → Security if other users share the machine.

## Requirements

- Linux x86_64. There is no arm64 build.
- The [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and logged in on
  the host. The app uses that login and your `~/.claude` (sessions, settings, MCP servers); it does
  not ask for a token. Run `claude` once in a terminal to log in.
- For the AppImage, `libfuse2` (`libfuse2t64` on Ubuntu 24.04). Without it, run the AppImage with
  `--appimage-extract-and-run`.

## Installing

**One command**

```bash
curl -fsSL https://raw.githubusercontent.com/yeyo11/agentry/main/scripts/install.sh | bash
```

It downloads the latest release and picks the package for your system: the `.deb` through apt on
Debian and Ubuntu (it asks for your password once), the AppImage everywhere else, installed under
`~/.local` with a menu entry and icon and no root. Options go after `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/yeyo11/agentry/main/scripts/install.sh | bash -s -- --version v0.7.0
curl -fsSL https://raw.githubusercontent.com/yeyo11/agentry/main/scripts/install.sh | bash -s -- --appimage
curl -fsSL https://raw.githubusercontent.com/yeyo11/agentry/main/scripts/install.sh | bash -s -- --uninstall
```

Uninstalling keeps your data (`~/.config/Agentry`, `~/Agentry`). Run it again to update.

**By hand**

Both files are attached to each [GitHub release](https://github.com/yeyo11/agentry/releases).

**AppImage**

```bash
chmod +x Agentry-<version>-x86_64.AppImage
./Agentry-<version>-x86_64.AppImage
```

**Debian / Ubuntu**

```bash
sudo apt install ./Agentry-<version>-amd64.deb
```

apt may end with a note that the download was "performed unsandboxed as root" because the file is
not readable by user `_apt`. That is harmless: the package installed. Installing from `/tmp`
avoids it.

This installs to `/opt/Agentry`, links `/usr/bin/agentry` and adds a launcher entry. Start it from
your application menu or with `agentry`.

The window opens on a splash screen while the server starts. If it cannot start, the window shows
the reason with a **Restart** button and a link to the logs.

## The window, the tray and the taskbar

**Title bar.** The window has no separate title bar: Agentry's own top bar is the title bar, and
dragging any empty part of it moves the window. The window controls sit on the right, drawn by the
system over a 54 px strip that matches the top bar, and follow the light or dark theme as you
change it (or as the system does, when the theme follows it). On macOS the traffic lights sit at the
top left instead, and the sidebar and top bar leave room for them. The splash and error pages can be
dragged too.

**Tray.** A tray icon says what is live. Its tooltip reads like "Agentry — 2 working · 1 waiting ·
1 orchestration"; Linux trays never show a tooltip, so the same line is also the first entry of its
menu. The menu has **Open Agentry**, **New chat**, up to eight live items — chats waiting for you
first, then working chats, then running orchestrations with their tasks done out of the total, and
"N more…" past that — and **Quit Agentry**. Picking an item opens it in the window without reloading
the page. Closing the window still quits the app: the tray shows what is live, it does not keep
Agentry running in the background.

**Progress and badge.** The taskbar or dock shows the combined progress of the running
orchestrations (tasks done over tasks, across all of them; indeterminate for one that has no tasks
yet), cleared when none runs. The badge counts the chats waiting for a person. Both appear where the
platform supports them: on Linux, docks that implement the Unity launcher API; the badge also on
macOS, not on Windows.

**Where the tray's data comes from.** Only the local server the app started: `/api/overview`, the
working and waiting chat lists and `/api/orchestrations` (these only while the overview says
something runs), re-read when the `/api/events` feed announces a change, at most every 1.5 s, and
every 30 s while the feed is down. If `AGENTRY_AUTH_TOKEN` is set in the app's environment, the tray
sends it as a bearer token. A token set only from Settings → Security is not known to the tray, so
its requests are refused: it then shows nothing live and the failures go to `desktop.log`. The tray
and the window menus are in English only.

## Where things live

| What | Path |
| --- | --- |
| Wrapper state (runs, orchestrations, accounts, `wrapper.db`) | `~/.config/Agentry/data` |
| Logs | `~/.config/Agentry/logs/desktop.log` and `server.log` |
| Default working directory for runs | `~/Agentry/workspace` |
| Claude Code config and transcripts | `~/.claude` (the CLI's own, unchanged) |

`~/.config` is `$XDG_CONFIG_HOME` if you set it. The workspace can be moved by starting the app
with `AGENTRY_WORKSPACE_DIR` set. Each run can still use any project directory.

The **File** menu opens the data, workspace and logs folders (press `Alt` if the menu bar is
hidden). Each log is rotated when the app starts once it passes 5 MB, keeping the last three.

Only one instance runs at a time: opening the app again focuses the existing window.

## The CLI is not detected

A launcher does not start the app from a login shell, so it would not see a `PATH` set up in your
shell profile (nvm, npm prefixes, `~/.local/bin`). To find the CLI the app builds the server's
`PATH` from, in order:

1. The `PATH` of your login shell, read with `$SHELL -ilc` (5 second timeout).
2. The `PATH` the app itself was started with.
3. Common install locations: `~/.local/bin`, `~/.npm-global/bin`, `~/.bun/bin`, `~/.volta/bin`,
   `~/.claude/local`, `/usr/local/bin`, `/usr/bin` and `/bin`.

Directories that do not exist are dropped. If the UI still says **Claude Code CLI not detected**:

1. Run `which claude` in a terminal. If that finds nothing, install the CLI first.
2. Check `~/.config/Agentry/logs/desktop.log`, and `server.log` for the server's own output.
3. If the CLI lives somewhere unusual, or your shell prints something that breaks non-interactive
   startup, launch the app from a terminal with the path set. The server inherits the environment:

   ```bash
   CLAUDE_BIN=/path/to/claude ./Agentry-<version>-x86_64.AppImage
   ```

The same applies to the optional [claude-swap](https://github.com/realiti4/claude-swap) binary for
multiple accounts (`CSWAP_BIN`). Any variable from the
[environment table](../README.md#environment-variables), such as `AGENTRY_DEFAULT_PERMISSION_MODE`,
can be set this way.

## Building from source

Needs Node 22+ and pnpm 10.

```bash
pnpm install
pnpm desktop:dev     # build the UI and the API bundle, then open Electron
pnpm desktop:dist    # AppImage and .deb
```

`desktop:dev` builds everything once and runs the shell against the repo's build output, with
DevTools in the View menu. It keeps its data in `~/.config/Agentry-dev`, apart from an installed
app. It does not watch for changes: rerun it after editing the UI or the API. For UI work,
`pnpm dev` and the browser are faster.

`pnpm --filter @agentry/desktop test` runs the shell's unit tests (the tray menu and tooltip, the
progress fraction, the event-stream reader, the title-bar options), and the root `pnpm test`
includes them.

The web UI knows it is in the app through `window.agentryDesktop`, which the preload exposes with
`platform`, `version`, `setTitleBarTheme({ color, symbolColor })` and `onNavigate(listener)`. When it
exists, `<html>` carries `is-desktop` and `desktop-<platform>`: `.is-desktop .topbar` and
`.is-desktop .sidebar-head` are the drag region (`app-region: drag`, with links, buttons, inputs and
menus opted out), the top bar keeps clear of the window controls with `env(titlebar-area-x)` and
`env(titlebar-area-width)`, and `desktop-darwin` leaves room for the traffic lights. The main process
accepts `setTitleBarTheme` only from the local server's page and only as hex colours; the web sends
the theme's `--bg` and `--text` whenever the theme changes. The title-bar overlay is 54 px tall
because the top bar is (`--topbar-h`): change one and change the other.

`desktop:dist` writes `Agentry-<version>-x86_64.AppImage` and `Agentry-<version>-amd64.deb` to
`apps/desktop/release/`. The first run downloads Electron and the packaging tools from GitHub, so it
needs network access. The packaging is configured in `apps/desktop/electron-builder.yml`.

## How releases publish it

[release-please](https://github.com/googleapis/release-please) creates a draft GitHub release as
described in [CONTRIBUTING.md](../CONTRIBUTING.md#how-a-release-happens). The release workflow then
calls `.github/workflows/desktop.yml`, which builds on Ubuntu with `pnpm desktop:dist` and attaches
the AppImage and the `.deb` to that draft before it is published. Re-running it for a tag replaces
the files while the release is still a draft; a published release is immutable, so a rebuild of one
only keeps the packages as a run artifact.

You can also run the **Desktop** workflow by hand from the Actions tab. With no tag it only builds
and keeps the packages as the `agentry-linux` run artifact, which is a way to try a change before a
release.

#!/usr/bin/env bash
# Installs the Agentry desktop app on Linux from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/yeyo11/agentry/main/scripts/install.sh | bash
#
# Debian/Ubuntu get the .deb through apt (asks for sudo once); every other distribution gets the
# AppImage in ~/.local, with a menu entry and icon, and no root at all.
#
# Options (after `bash -s --` when piped):
#   --version vX.Y.Z   install that release instead of the latest
#   --appimage         use the AppImage even where apt is available
#   --uninstall        remove what this script installed
set -euo pipefail

REPO="yeyo11/agentry"
VERSION=""
FORMAT=""
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a tag, e.g. v0.7.0}"; shift 2 ;;
    --appimage) FORMAT="appimage"; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,14p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;38;5;173m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }

BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/agentry"
DESKTOP_FILE="$HOME/.local/share/applications/agentry.desktop"
ICON_FILE="$HOME/.local/share/icons/hicolor/512x512/apps/agentry.png"

sudo_() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

if [ "$UNINSTALL" -eq 1 ]; then
  # The AppImage's files first: they need no password, so a declined sudo below still leaves them gone
  rm -f "$BIN_DIR/agentry" "$DESKTOP_FILE" "$ICON_FILE"
  rm -rf "$APP_DIR"
  if dpkg -s agentry >/dev/null 2>&1; then
    say "Removing the agentry package (it may ask for your password)"
    sudo_ apt-get remove -y agentry
  fi
  say "Agentry removed. Your data in ~/.config/Agentry and ~/Agentry was kept."
  exit 0
fi

[ "$(uname -s)" = "Linux" ] || fail "the desktop app is Linux-only; elsewhere run it with Docker (see the README)"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "only x86_64 builds are published so far (this machine is $(uname -m))" ;;
esac
need curl

if [ -z "$FORMAT" ]; then
  if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then FORMAT="deb"; else FORMAT="appimage"; fi
fi

TMP="$(mktemp -d)"
# Readable by apt's unprivileged _apt user, which cannot enter a home directory
chmod 755 "$TMP"
trap 'rm -rf "$TMP"' EXIT

# The release's asset list, from the API: no guessing file names from the version. Parsed from a
# file, not a pipe: a reader that stops early would SIGPIPE the writer and pipefail would abort.
if [ -n "$VERSION" ]; then API="https://api.github.com/repos/$REPO/releases/tags/$VERSION"; else API="https://api.github.com/repos/$REPO/releases/latest"; fi
curl -fsSL -H 'Accept: application/vnd.github+json' -o "$TMP/release.json" "$API" || fail "could not read the release from GitHub ($API)"
TAG="$(sed -n -E 's/.*"tag_name": *"([^"]+)".*/\1/p' "$TMP/release.json")"
TAG="${TAG%%$'\n'*}"
if [ "$FORMAT" = "deb" ]; then SUFFIX='amd64.deb'; else SUFFIX='x86_64.AppImage'; fi
URL=""
while IFS= read -r url; do
  case "$url" in *"$SUFFIX") URL="$url"; break ;; esac
done < <(sed -n -E 's/.*"browser_download_url": *"(https:[^"]+)".*/\1/p' "$TMP/release.json")
[ -n "$URL" ] || fail "release ${TAG:-?} has no $FORMAT package yet"

FILE="$TMP/$(basename "$URL")"
say "Downloading Agentry $TAG ($FORMAT)"
curl -fL --progress-bar -o "$FILE" "$URL"
chmod 644 "$FILE"

if [ "$FORMAT" = "deb" ]; then
  say "Installing with apt (it may ask for your password)"
  sudo_ apt-get install -y "$FILE"
else
  mkdir -p "$APP_DIR" "$BIN_DIR" "$(dirname "$DESKTOP_FILE")" "$(dirname "$ICON_FILE")"
  install -m 755 "$FILE" "$APP_DIR/Agentry.AppImage"
  ln -sf "$APP_DIR/Agentry.AppImage" "$BIN_DIR/agentry"
  curl -fsSL -o "$ICON_FILE" "https://raw.githubusercontent.com/$REPO/$TAG/apps/desktop/build/icons/512x512.png" || true
  cat > "$DESKTOP_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Agentry
GenericName=Claude Code Control Panel
Comment=Desktop UI for Claude Code agents: runs, sessions and multi-agent orchestration
Exec=$APP_DIR/Agentry.AppImage %U
Icon=agentry
Terminal=false
Categories=Development;
Keywords=Claude;Claude Code;AI;agents;orchestration;
StartupWMClass=agentry
DESKTOP
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$(dirname "$DESKTOP_FILE")" || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$HOME/.local/share/icons/hicolor" || true
  # AppImages mount themselves with FUSE 2
  # Matched without a pipe: `grep -q` quitting early SIGPIPEs the writer, which pipefail reads as no match
  LIBS="$(ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null || true)"
  case "$LIBS" in
    *libfuse.so.2*) ;;
    *) say "Note: the AppImage needs libfuse2 (libfuse2t64 on Ubuntu 24.04+) to start" ;;
  esac
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "Note: add $BIN_DIR to your PATH to run 'agentry' from a terminal" ;; esac
fi

if ! command -v claude >/dev/null 2>&1; then
  say "Agentry drives the Claude Code CLI, which is not on your PATH yet:"
  echo "    curl -fsSL https://claude.ai/install.sh | bash"
fi
say "Agentry $TAG installed. Open it from your applications menu, or run: agentry"

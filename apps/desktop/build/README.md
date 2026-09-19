# Desktop build resources

Static assets for the Linux desktop app. This is electron-builder's default `buildResources`
directory, so nothing here needs to be referenced explicitly.

| Path | What it is |
| --- | --- |
| `icon.svg` | Master icon (512 viewBox, 32px padding). Same mark and gradient as `apps/web/public/favicon.svg`. |
| `icon.png` | 512x512 rasterization of the master. |
| `icons/<size>x<size>.png` | Linux icon set: 16, 32, 48, 64, 128, 256, 512. |
| `linux/agentry.desktop` | Desktop entry template (`Icon=agentry`, `StartupWMClass=Agentry`). |
| `linux/io.github.yeyo11.agentry.metainfo.xml` | AppStream metadata. App id: `io.github.yeyo11.agentry`. |

## Regenerating the PNGs

`icon.svg` is the source of truth. Edit it, then rerun this from `apps/desktop/build`. It installs
`sharp` into a temp dir, so nothing is added to the workspace:

```bash
T=$(mktemp -d)
(cd "$T" && npm init -y >/dev/null && npm i sharp)
cat > "$T/render.mjs" <<'EOF'
import sharp from 'sharp';
const render = (file, size) =>
  sharp('icon.svg', { density: (72 * size * 2) / 512 }).resize(size, size).png().toFile(file);
await render('icon.png', 512);
for (const size of [16, 32, 48, 64, 128, 256, 512]) await render(`icons/${size}x${size}.png`, size);
EOF
(cd apps/desktop/build && node "$T/render.mjs")
rm -rf "$T"
```

Run it from the repo root. The script resolves `sharp` from its own directory and reads/writes
relative to `apps/desktop/build`.

Or, if `rsvg-convert` is installed:

```bash
cd apps/desktop/build && rsvg-convert -w 512 -h 512 icon.svg -o icon.png \
  && for s in 16 32 48 64 128 256 512; do rsvg-convert -w $s -h $s icon.svg -o icons/${s}x${s}.png; done
```

## Validating the Linux metadata

```bash
desktop-file-validate linux/agentry.desktop
appstreamcli validate --no-net linux/io.github.yeyo11.agentry.metainfo.xml
```

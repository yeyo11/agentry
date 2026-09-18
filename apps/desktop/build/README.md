# Desktop build resources

electron-builder's `buildResources` directory for the Linux desktop app (AppImage and .deb).

| Asset | Purpose |
| --- | --- |
| `icon.svg` | Master app icon: the web favicon (`apps/web/public/favicon.svg`) on a 512 canvas with a 32px margin |
| `icon.png` | 512x512 rasterization of `icon.svg` |
| `icons/<n>x<n>.png` | Linux icon set (16, 32, 48, 64, 128, 256, 512); electron-builder installs each into `hicolor/<n>x<n>/apps` |
| `render-icons.mjs` | Zero-dependency script that rasterizes `icon.svg` into `icon.png` and `icons/` |
| `linux/agentry.desktop` | Desktop entry template (`Icon=agentry`, `StartupWMClass=Agentry`) |
| `linux/io.github.yeyo11.agentry.metainfo.xml` | AppStream metadata; app id `io.github.yeyo11.agentry` |

## Regenerating the PNGs

After editing `icon.svg`, from the repository root:

```bash
node apps/desktop/build/render-icons.mjs
```

The script only understands the SVG subset `icon.svg` uses today (one translate/scale group, a
rounded rect with a linear gradient, stroked paths with M/L/H/V/C, filled circles). For anything
beyond that, use a full rasterizer instead:

```bash
for n in 16 32 48 64 128 256 512; do
  rsvg-convert -w $n -h $n apps/desktop/build/icon.svg -o apps/desktop/build/icons/${n}x${n}.png
done
cp apps/desktop/build/icons/512x512.png apps/desktop/build/icon.png
```

## Validating the Linux metadata

```bash
desktop-file-validate apps/desktop/build/linux/agentry.desktop
appstreamcli validate --no-net apps/desktop/build/linux/io.github.yeyo11.agentry.metainfo.xml
```

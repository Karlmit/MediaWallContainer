# MediaWall Local Optimizer

This tool pre-creates the optional `/optimized` video library outside the Docker server. It is useful for the first big conversion pass on a stronger Windows PC.

## Requirements

- Node.js
- FFmpeg and FFprobe available in `PATH`
- Original media path should point at the same files the Docker server sees, preferably the Unraid SMB share. MediaWall matches optimized files by relative path, file size, and modified time.

## Run

Open the GUI:

```powershell
npm run optimize:local:gui
```

Double-click:

```text
tools\local-optimizer\run-gui-windows.bat
```

The GUI shows active transcodes, percent, speed, fps, totals, logs, and the generated compose recommendation. On a powerful NVIDIA GPU, increase concurrent jobs until GPU usage is high but the PC remains responsive. `p1` is fastest, while `p5` is a balanced preset.

## Terminal Run

Double-click:

```text
tools\local-optimizer\run-windows.bat
```

Or run:

```powershell
npm run optimize:local
```

You can also run it non-interactively:

```powershell
node tools\local-optimizer\optimizer.js `
  --original "\\tower\Media" `
  --output "D:\MediaWallOptimized" `
  --mode all `
  --max-height 720 `
  --quality 23 `
  --nvenc-preset p5 `
  --concurrency 6 `
  --limit 500
```

The tool asks for:

- Original media folder
- Optimized output folder
- Whether to optimize all videos or only videos that need it
- Max height such as `720` or `1080`
- Bitrate threshold for `needed` mode
- NVENC preset, such as `p1` fastest or `p5` balanced
- Quality settings

The output folder will contain MP4 files plus `manifest.json`. Mount that same folder as `/optimized` in Docker.

## Docker Settings To Match

Use the compose recommendation printed at the end. The key values are:

```yaml
OPTIMIZED_MEDIA_DIR: "/optimized"
OPTIMIZE_VIDEOS: "needed"
OPTIMIZE_MAX_HEIGHT: "720"
OPTIMIZE_CRF: "23"
OPTIMIZE_MIN_BITRATE_MBPS: "8"
```

If the local optimizer used `nvenc`, the Docker server can still use `vaapi` or `software` later for new files. The important matching settings are `OPTIMIZE_MAX_HEIGHT` and `OPTIMIZE_CRF`, because MediaWall uses those when deciding whether an optimized cache entry is reusable.

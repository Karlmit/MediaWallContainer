# Media Wall

Media Wall is a fullscreen media collage for images and videos. This repository now contains both supported app hosts:

- **Docker web app** for servers such as Unraid.
- **Windows desktop app** for local folder picking and fullscreen playback.

Both versions use the same shared wall UI, so feature updates should land in both unless the feature is host-specific.

## Features

- Displays many images and videos fullscreen from a folder and its subfolders.
- Automatically packs media tiles to fill the screen.
- Randomly swaps media over time.
- Supports image/video subfolder filters.
- Supports crop-to-fill or contain mode.
- Mouse wheel changes visible item count.
- Space pauses/resumes random swaps.
- Shift+D opens the Docker diagnostics view with transcode status and recent server logs.
- ArrowRight refreshes the visible set.
- ArrowUp/ArrowDown adjusts visible item count.
- Right-click tiles to select them, then middle-click to show only selected tiles.
- Videos are protected from random replacement until they have completed at least once.
- Docker version includes password login, mounted-folder configuration, FFmpeg fallback transcoding, optional optimized video copies, background pre-cache, and cache cleanup.

## Windows Desktop App

Download the latest Windows zip from:

https://github.com/Karlmit/MediaWall/releases

Extract the zip and run `Media Wall.exe`.

The desktop app asks you to choose a folder the first time it opens. It remembers the last folder, watches it for changes, and uses the same wall controls as the Docker version. This is the easiest install if you just want to run MediaWall directly on a Windows machine without hosting it on a server.

## Unraid Compose

Use the published Docker image:

```yaml
services:
  media-wall:
    image: ghcr.io/karlmit/mediawall:latest
    container_name: media-wall
    ports:
      - "3000:3000"
    environment:
      MEDIA_PASSWORD: "change-this-password"
      MEDIA_DIR: "/media"
      SESSION_SECRET: "change-this-to-a-long-random-string"
      TRANSCODE_CACHE_DIR: "/cache"
      PRECACHE_VIDEOS: "true"
      TRANSCODE_CONCURRENCY: "1"
      TRANSCODE_ACCEL: "software"
      VAAPI_DEVICE: "/dev/dri/renderD128"
      LIBVA_DRIVER_NAME: "iHD"
      # Optional smaller playback copies. Leave unset to disable.
      # OPTIMIZED_MEDIA_DIR: "/optimized"
      # OPTIMIZE_VIDEOS: "needed"
      # OPTIMIZE_MAX_HEIGHT: "1080"
      # OPTIMIZE_MIN_BITRATE_MBPS: "8"
    # Uncomment on Unraid/Linux with Intel iGPU passthrough.
    # devices:
    #   - "/dev/dri:/dev/dri"
    volumes:
      - "/mnt/user/Media:/media:ro"
      - "/mnt/user/appdata/mediawall-cache:/cache"
      # Optional optimized playback library.
      # - "/mnt/user/appdata/mediawall-optimized:/optimized"
    restart: unless-stopped
```

Change `MEDIA_PASSWORD`, `SESSION_SECRET`, and `/mnt/user/Media`.

With `image: ghcr.io/karlmit/mediawall:latest`, Unraid can check the registry image for updates. Rebuilds from GitHub source with `build:` do not reliably show up in Unraid's update checker.

The `/cache` mount stores generated browser-compatible MP4 files. Originals are never deleted. When a source video is removed from `/media`, its generated cache file is removed from `/cache` on the next scan. You can point `/cache` at any persistent Unraid path, such as `/mnt/user/appdata/mediawall-cache`.

The optional `/optimized` mount stores smaller playback copies for videos that are already browser-compatible but too large for smooth multi-video playback. Originals are never changed. When a source video is removed from `/media`, its optimized copy is removed from `/optimized` on the next scan.

Transcoding options:

- `PRECACHE_VIDEOS=true` scans video codecs and starts converting incompatible files in the background.
- `TRANSCODE_CONCURRENCY=1` limits how many conversions run at once. Increase only if your server has enough CPU.
- `TRANSCODE_ENABLED=false` disables Docker-side conversion and lets the browser try original files only.
- `TRANSCODE_ACCEL=software` uses CPU x264 encoding.
- `TRANSCODE_ACCEL=vaapi` uses Intel iGPU encoding through `/dev/dri` and falls back to software if the device or encoder fails.
- `TRANSCODE_ACCEL=auto` tries VAAPI first, then falls back to software.
- `OPTIMIZED_MEDIA_DIR=/optimized` enables the separate optimized-copy library when the `/optimized` volume is mounted.
- `OPTIMIZE_VIDEOS=needed` optimizes videos that are browser-incompatible, taller than `OPTIMIZE_MAX_HEIGHT`, or above `OPTIMIZE_MIN_BITRATE_MBPS`.
- `OPTIMIZE_VIDEOS=all` optimizes every video into the `/optimized` volume.
- `OPTIMIZE_MAX_HEIGHT=1080` caps optimized copies to 1080p while preserving aspect ratio. Use `720` for smaller/faster playback.
- `OPTIMIZE_MIN_BITRATE_MBPS=8` controls when `needed` treats a browser-playable video as too large.

### Intel iGPU / Quick Sync on Unraid

For Intel CPUs with an iGPU, pass `/dev/dri` into the container and use VAAPI acceleration:

```yaml
services:
  media-wall:
    image: ghcr.io/karlmit/mediawall:latest
    container_name: media-wall
    ports:
      - "3000:3000"
    environment:
      MEDIA_PASSWORD: "change-this-password"
      MEDIA_DIR: "/media"
      SESSION_SECRET: "change-this-to-a-long-random-string"
      TRANSCODE_CACHE_DIR: "/cache"
      PRECACHE_VIDEOS: "true"
      TRANSCODE_CONCURRENCY: "2"
      TRANSCODE_ACCEL: "vaapi"
      VAAPI_DEVICE: "/dev/dri/renderD128"
      LIBVA_DRIVER_NAME: "iHD"
      OPTIMIZED_MEDIA_DIR: "/optimized"
      OPTIMIZE_VIDEOS: "needed"
      OPTIMIZE_MAX_HEIGHT: "1080"
      OPTIMIZE_MIN_BITRATE_MBPS: "8"
    devices:
      - "/dev/dri:/dev/dri"
    volumes:
      - "/mnt/user/Media:/media:ro"
      - "/mnt/user/appdata/mediawall-cache:/cache"
      - "/mnt/user/appdata/mediawall-optimized:/optimized"
    restart: unless-stopped
```

During first cache warmup, start with `TRANSCODE_CONCURRENCY=1` or `2`. Your Intel Core i5-14600K should handle VAAPI very well, but playback and background transcoding still share the same iGPU and storage.

Open the app and press `Shift+D` to view active transcodes, optimization jobs, queued files, recent completed/failed jobs, and recent server log events without opening the Docker log stream. Successful hardware jobs show `ready vaapi`; fallback jobs show `ready software`.

### Optional Optimized Playback Library

If your originals are very large, add a third volume and enable optimization:

```yaml
environment:
  OPTIMIZED_MEDIA_DIR: "/optimized"
  OPTIMIZE_VIDEOS: "needed"
  OPTIMIZE_MAX_HEIGHT: "1080"
  OPTIMIZE_MIN_BITRATE_MBPS: "8"
volumes:
  - "/mnt/user/Media:/media:ro"
  - "/mnt/user/appdata/mediawall-cache:/cache"
  - "/mnt/user/appdata/mediawall-optimized:/optimized"
```

Use `OPTIMIZE_VIDEOS=needed` for the usual case. It avoids converting small files that are already fine. Use `OPTIMIZE_VIDEOS=all` if you want a complete playback library where every video has a generated MP4 copy.

For a wall that shows many videos at once, `OPTIMIZE_MAX_HEIGHT=720` may feel smoother than 1080p. The visual tiles are often much smaller than fullscreen video, so 720p is usually enough for the collage.

## Local Docker Build

Edit `docker-compose.yml`:

- Change `MEDIA_PASSWORD` to the password you want for the website.
- Change `SESSION_SECRET` to any long random string.
- Change the left side of the volume mount to your media folder.

Example:

```yaml
volumes:
  - "D:/Photos And Videos:/media:ro"
```

Start it:

```sh
docker compose up -d --build
```

Open `http://localhost:3000`, enter the password, then use the browser fullscreen button or `F11`.

Supported image files: `jpg`, `jpeg`, `png`, `gif`, `webp`, `bmp`, `avif`.

Supported video files: `mp4`, `webm`, `mov`, `m4v`, `ogg`, `ogv`, `mkv`.

Videos play directly when the browser supports their codecs. The Docker host uses FFprobe to identify videos likely to fail in browsers and uses FFmpeg to create cached browser-compatible MP4 fallbacks in the `media-wall-cache` Docker volume. If the optional optimized library is enabled, the app prefers ready optimized copies from `/optimized` for smoother playback.

## Development

Run the Docker/web host locally:

```sh
npm run start:web
```

Run the Windows desktop host locally:

```sh
npm run start:desktop
```

Build the Windows desktop app:

```sh
npm run build:desktop
```

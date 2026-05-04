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
- Docker version includes password login, mounted-folder configuration, FFmpeg fallback transcoding, background pre-cache, and cache cleanup for browser-incompatible videos.

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
    # Uncomment on Unraid/Linux with Intel iGPU passthrough.
    # devices:
    #   - "/dev/dri:/dev/dri"
    volumes:
      - "/mnt/user/Media:/media:ro"
      - "/mnt/user/appdata/mediawall-cache:/cache"
    restart: unless-stopped
```

Change `MEDIA_PASSWORD`, `SESSION_SECRET`, and `/mnt/user/Media`.

With `image: ghcr.io/karlmit/mediawall:latest`, Unraid can check the registry image for updates. Rebuilds from GitHub source with `build:` do not reliably show up in Unraid's update checker.

The `/cache` mount stores generated browser-compatible MP4 files. Originals are never deleted. When a source video is removed from `/media`, its generated cache file is removed from `/cache` on the next scan. You can point `/cache` at any persistent Unraid path, such as `/mnt/user/appdata/mediawall-cache`.

Transcoding options:

- `PRECACHE_VIDEOS=true` scans video codecs and starts converting incompatible files in the background.
- `TRANSCODE_CONCURRENCY=1` limits how many conversions run at once. Increase only if your server has enough CPU.
- `TRANSCODE_ENABLED=false` disables Docker-side conversion and lets the browser try original files only.
- `TRANSCODE_ACCEL=software` uses CPU x264 encoding.
- `TRANSCODE_ACCEL=vaapi` uses Intel iGPU encoding through `/dev/dri` and falls back to software if the device or encoder fails.
- `TRANSCODE_ACCEL=auto` tries VAAPI first, then falls back to software.

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
    devices:
      - "/dev/dri:/dev/dri"
    volumes:
      - "/mnt/user/Media:/media:ro"
      - "/mnt/user/appdata/mediawall-cache:/cache"
    restart: unless-stopped
```

During first cache warmup, start with `TRANSCODE_CONCURRENCY=1` or `2`. Your Intel Core i5-14600K should handle VAAPI very well, but playback and background transcoding still share the same iGPU and storage.

Open the app and press `Shift+D` to view active transcodes, queued files, recent completed/failed jobs, and recent server log events without opening the Docker log stream. Successful hardware jobs show `ready vaapi`; fallback jobs show `ready software`.

## Windows Desktop App

Download the latest Windows zip from:

https://github.com/Karlmit/MediaWall/releases

Extract it and run `Media Wall.exe`.

The desktop app asks you to choose a folder. It remembers the last folder and watches it for changes.

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

Videos play directly when the browser supports their codecs. The Docker host uses FFprobe to identify videos likely to fail in browsers and uses FFmpeg to create cached browser-compatible MP4 fallbacks in the `media-wall-cache` Docker volume.

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

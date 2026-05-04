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
- ArrowRight refreshes the visible set.
- ArrowUp/ArrowDown adjusts visible item count.
- Right-click tiles to select them, then middle-click to show only selected tiles.
- Videos are protected from random replacement until they have completed at least once.
- Docker version includes password login, mounted-folder configuration, and FFmpeg fallback transcoding for browser-incompatible videos.

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
    volumes:
      - "/mnt/user/Media:/media:ro"
      - "media-wall-cache:/cache"
    restart: unless-stopped

volumes:
  media-wall-cache:
```

Change `MEDIA_PASSWORD`, `SESSION_SECRET`, and `/mnt/user/Media`.

With `image: ghcr.io/karlmit/mediawall:latest`, Unraid can check the registry image for updates. Rebuilds from GitHub source with `build:` do not reliably show up in Unraid's update checker.

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

Videos play directly when the browser supports their codecs. If a video fails to play, the server uses FFmpeg to create a cached browser-compatible MP4 fallback in the `media-wall-cache` Docker volume.

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

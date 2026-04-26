# Media Wall

Docker-hostable fullscreen media wall for images and videos.

## Unraid Compose

Use the published Docker image:

```yaml
services:
  media-wall:
    image: ghcr.io/karlmit/mediawallcontainer:latest
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

With `image: ghcr.io/karlmit/mediawallcontainer:latest`, Unraid can check the registry image for updates. Rebuilds from GitHub source with `build:` do not reliably show up in Unraid's update checker.

## Local Build

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

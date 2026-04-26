# Media Wall

Docker-hostable fullscreen media wall for images and videos.

## Run

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

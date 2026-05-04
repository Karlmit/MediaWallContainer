FROM node:22-alpine

ARG VERSION=dev
LABEL org.opencontainers.image.title="MediaWall"
LABEL org.opencontainers.image.description="Unified desktop and Docker fullscreen media wall for images and videos."
LABEL org.opencontainers.image.source="https://github.com/Karlmit/MediaWall"
LABEL org.opencontainers.image.version="${VERSION}"

WORKDIR /app

RUN apk add --no-cache ffmpeg intel-media-driver libva-utils mesa-va-gallium

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV MEDIA_DIR=/media
ENV TRANSCODE_CACHE_DIR=/cache
ENV LIBVA_DRIVER_NAME=iHD

EXPOSE 3000

CMD ["npm", "run", "start:web"]

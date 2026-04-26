FROM node:22-alpine

ARG VERSION=dev
LABEL org.opencontainers.image.title="MediaWallContainer"
LABEL org.opencontainers.image.description="Docker-hostable fullscreen media wall for images and videos."
LABEL org.opencontainers.image.source="https://github.com/Karlmit/MediaWallContainer"
LABEL org.opencontainers.image.version="${VERSION}"

WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV MEDIA_DIR=/media
ENV TRANSCODE_CACHE_DIR=/cache

EXPOSE 3000

CMD ["npm", "start"]

FROM node:22-alpine

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

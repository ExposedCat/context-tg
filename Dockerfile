FROM docker.io/oven/bun:1.4.3

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 \
  && ln -sf /usr/bin/python3 /usr/local/bin/python \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod 0755 /usr/local/bin/yt-dlp \
  && yt-dlp --version \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so source edits reuse the cached install layer.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

COPY . .

CMD ["bun", "src/app.ts"]

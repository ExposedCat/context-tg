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

# Keep the Chromium layer independent of the app dependencies.
ARG PLAYWRIGHT_VERSION=1.65.1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN set -eu; \
  install_tmp="$(mktemp -d)"; \
  TMPDIR="$install_tmp" BUN_INSTALL_CACHE_DIR="$install_tmp/cache" \
    bunx --bun "playwright-core@$PLAYWRIGHT_VERSION" install --with-deps --only-shell chromium; \
  rm -rf "$install_tmp" /var/lib/apt/lists/*

# Copy dependency manifests before source so code edits reuse the install layer.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production \
  && bun -e 'const version = require("playwright-core/package.json").version; if (version !== Bun.env.PLAYWRIGHT_VERSION) throw new Error(`Set the Dockerfile PLAYWRIGHT_VERSION to ${version}.`);'

COPY . .

CMD ["bun", "src/app.ts"]

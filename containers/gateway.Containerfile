FROM docker.io/oven/bun:1.4.0-debian

WORKDIR /app

COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
COPY --chown=bun:bun src ./src

USER bun

ENV LOYLEX_DATABASE_PATH=/data/loylex.sqlite
ENV LOYLEX_LISTEN_HOST=0.0.0.0
ENV LOYLEX_LISTEN_PORT=8787

EXPOSE 8787

CMD ["bun", "src/gateway/main.ts"]

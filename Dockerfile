FROM denoland/deno:2.8.1

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 \
  && ln -sf /usr/bin/python3 /usr/local/bin/python \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod 0755 /usr/local/bin/yt-dlp \
  && yt-dlp --version \
  && rm -rf /var/lib/apt/lists/*

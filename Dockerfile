FROM denoland/deno:2.8.1

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 \
  && ln -sf /usr/bin/python3 /usr/local/bin/python \
  && rm -rf /var/lib/apt/lists/*

FROM quay.io/fedora/fedora:44

ARG BUN_VERSION=1.4.0
ARG CODEX_VERSION=0.151.0

RUN dnf install -y \
      bash-completion \
      bzip2 \
      clang \
      cmake \
      coreutils \
      cronie \
      curl \
      diffutils \
      fd-find \
      ffmpeg-free \
      file \
      findutils \
      gcc \
      gcc-c++ \
      gh \
      git \
      git-lfs \
      glibc-langpack-en \
      glibc-langpack-ru \
      ImageMagick \
      jq \
      make \
      nano \
      nodejs \
      npm \
      openssh-clients \
      patch \
      procps-ng \
      python3 \
      python3-pip \
      ripgrep \
      rsync \
      sqlite \
      sudo \
      tar \
      tmux \
      tree \
      unzip \
      util-linux \
      wget \
      which \
      xz \
      zip \
      zstd \
    && curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
    && ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && useradd --create-home --uid 1000 --shell /bin/bash loylex \
    && printf 'loylex ALL=(ALL) NOPASSWD: ALL\n' >/etc/sudoers.d/loylex \
    && chmod 0440 /etc/sudoers.d/loylex \
    && mkdir -p /memory /workspace /opt/loylex/app \
    && chown -R loylex:loylex /memory /workspace /opt/loylex \
    && dnf clean all \
    && rm -rf /tmp/bun /tmp/bun.zip /root/.npm

RUN python3 -m pip install \
      --no-cache-dir \
      --disable-pip-version-check \
      --target /opt/loylex/python \
      "pybooru==4.2.2"

COPY --chown=loylex:loylex package.json bun.lock tsconfig.json /opt/loylex/app/
COPY --chown=loylex:loylex src /opt/loylex/app/src
COPY --chown=loylex:loylex AGENTS.md /opt/loylex/seed/AGENTS.md
COPY --chown=loylex:loylex skills /opt/loylex/seed/skills
COPY --chown=loylex:loylex memory-seed /opt/loylex/memory-seed
COPY --chmod=0755 containers/agent-entrypoint.sh /usr/local/bin/loylex-agent
COPY --chmod=0755 containers/loylex-cli /usr/local/bin/loylex

USER loylex
WORKDIR /workspace/Loylex

ENV CODEX_HOME=/home/loylex/.codex
ENV LANG=en_US.UTF-8
ENV LOYLEX_MEMORY_PATH=/memory
ENV LOYLEX_REPOSITORY_PATH=/workspace/Loylex
ENV PYTHONPATH=/opt/loylex/python
ENV PATH=/home/loylex/.local/bin:/usr/local/bin:/usr/bin

ENTRYPOINT ["loylex-agent"]

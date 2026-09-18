# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

# Tools Claude Code relies on when working inside projects
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client procps ripgrep jq python3 \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

# Volumes are owned by the non-root user (bypassPermissions refuses to run as root)
RUN mkdir -p /app /workspace /data /home/node/.claude \
 && chown -R node:node /app /workspace /data /home/node
USER node
ENV HOME=/home/node \
    PATH=/home/node/.local/bin:$PATH

# Claude Code native build. Pin with --build-arg CLAUDE_CODE_VERSION=2.1.276
ARG CLAUDE_CODE_VERSION=latest
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- ${CLAUDE_CODE_VERSION} \
 && claude --version

# claude-swap owns the account credentials when several accounts are registered (multi-account
# rotation). Its own data dir is a volume, so the accounts survive a rebuild.
ARG CLAUDE_SWAP_VERSION=
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
 && uv tool install claude-swap${CLAUDE_SWAP_VERSION:+==${CLAUDE_SWAP_VERSION}} \
 && cswap --version

WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY --chown=node:node packages/shared/package.json packages/shared/
COPY --chown=node:node packages/core/package.json packages/core/
COPY --chown=node:node apps/api/package.json apps/api/
COPY --chown=node:node apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY --chown=node:node packages packages
COPY --chown=node:node apps apps
RUN pnpm --filter @agentry/web build

# Keeping .claude.json inside the config dir means one volume persists the whole account setup
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    AGENTRY_WORKSPACE_DIR=/workspace \
    AGENTRY_DATA_DIR=/data \
    AGENTRY_DEFAULT_PERMISSION_MODE=bypassPermissions \
    DISABLE_AUTOUPDATER=1

EXPOSE 8787
VOLUME ["/home/node/.claude", "/workspace", "/data", "/home/node/.local/share/claude-swap"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD curl -fsS http://localhost:8787/api/health || exit 1

CMD ["pnpm", "--filter", "@agentry/api", "start"]

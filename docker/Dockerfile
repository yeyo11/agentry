# syntax=docker/dockerfile:1

# The API is compiled here and only the result is shipped. esbuild turns each entrypoint into a
# self-contained ESM file (apps/api/scripts/bundle.mjs), so the image that runs it carries no
# source tree, no node_modules and no transpiler: the container used to start `tsx src/index.ts`
# and parse the whole of TypeScript on every boot.
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps apps
RUN pnpm --filter @agentry/web build \
 && pnpm --filter @agentry/api bundle

FROM node:22-bookworm-slim

# Tools Claude Code relies on when working inside projects
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client procps ripgrep jq python3 \
 && rm -rf /var/lib/apt/lists/*

# Nothing here needs pnpm any more: it is left for the projects Claude works on under /workspace,
# which is also why node and python3 stay.
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

# Volumes are owned by the non-root user (bypassPermissions refuses to run as root)
RUN mkdir -p /app /workspace /data /home/node/.claude \
 && chown -R node:node /app /workspace /data /home/node
USER node
ENV HOME=/home/node \
    PATH=/home/node/.local/bin:$PATH

# Claude Code native build, pinned so that an image is the same tomorrow as today: the CLI moves
# faster than this project, and a rebuild must not change behaviour by accident. Bump it on purpose
# (the System page says when a newer one exists), or override it with
# --build-arg CLAUDE_CODE_VERSION=<version>. `latest` and `stable` still work and count as unpinned.
ARG CLAUDE_CODE_VERSION=2.1.278
# One URL always serves the newest installer, so the script is pinned by content instead of by
# version: a build that would otherwise pipe an unreviewed script into a shell stops at the
# checksum. To rotate, run `curl -fsSL https://claude.ai/install.sh | sha256sum`, read the diff
# against the script this digest covers, and land the new digest in a commit that says what moved.
# Override with --build-arg CLAUDE_CODE_INSTALLER_SHA256=<digest> to build ahead of that commit.
ARG CLAUDE_CODE_INSTALLER_SHA256=3a68d3406cf674e17bed1733a4dcf37805e2e47d87417700007d7e1aa766a944
RUN curl -fsSL -o /tmp/claude-install.sh https://claude.ai/install.sh \
 && echo "${CLAUDE_CODE_INSTALLER_SHA256}  /tmp/claude-install.sh" | sha256sum -c - \
 && bash /tmp/claude-install.sh ${CLAUDE_CODE_VERSION} \
 && rm /tmp/claude-install.sh \
 && claude --version
# Read by the update check, which compares it with the newest published version
ENV AGENTRY_CLAUDE_CODE_PINNED=${CLAUDE_CODE_VERSION}

# claude-swap owns the account credentials when several accounts are registered (multi-account
# rotation). Its own data dir is a volume, so the accounts survive a rebuild.
ARG CLAUDE_SWAP_VERSION=
# astral.sh serves a separate installer per uv release, so this URL is immutable and its digest
# only moves when UV_VERSION does: bump the two together, taking the new digest from
# `curl -fsSL https://astral.sh/uv/<version>/install.sh | sha256sum`. Unpinned, the image would
# take whatever uv shipped that morning, and an unverified script would install it.
ARG UV_VERSION=0.12.18
ARG UV_INSTALLER_SHA256=e62a5ea089de9c6a9b1f767166c9f33194e18d350e9f375c6355fac3ba0fb42b
RUN curl -fsSL -o /tmp/uv-install.sh https://astral.sh/uv/${UV_VERSION}/install.sh \
 && echo "${UV_INSTALLER_SHA256}  /tmp/uv-install.sh" | sha256sum -c - \
 && sh /tmp/uv-install.sh \
 && rm /tmp/uv-install.sh \
 && uv --version \
 && uv tool install claude-swap${CLAUDE_SWAP_VERSION:+==${CLAUDE_SWAP_VERSION}} \
 && cswap --version

WORKDIR /app
# The whole of the wrapper: one JavaScript file and the built UI beside it
COPY --from=build --chown=node:node /app/apps/api/dist/api.mjs /app/api.mjs
COPY --from=build --chown=node:node /app/apps/web/dist /app/web

# Keeping .claude.json inside the config dir means one volume persists the whole account setup
ENV NODE_ENV=production \
    AGENTRY_PID_FILE=/tmp/agentry.pid \
    PORT=8787 \
    HOST=0.0.0.0 \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    AGENTRY_WORKSPACE_DIR=/workspace \
    AGENTRY_DATA_DIR=/data \
    AGENTRY_DEFAULT_PERMISSION_MODE=bypassPermissions \
    DISABLE_AUTOUPDATER=1 \
    AGENTRY_WEB_DIST=/app/web

EXPOSE 8787
VOLUME ["/home/node/.claude", "/workspace", "/data", "/home/node/.local/share/claude-swap"]

# The script also ends the server after a few failed probes, which is what makes a restart policy
# act on an unhealthy container (see docs/deploy.md)
COPY --chown=node:node --chmod=755 docker/healthcheck.sh /app/healthcheck.sh
HEALTHCHECK --interval=30s --timeout=15s --start-period=20s --retries=3 \
  CMD ["/app/healthcheck.sh"]

# Exec form with no package manager in between: `docker stop` signals the server itself, so the
# container's exit status is the server's (0) and not a package manager's report of a killed child
# (143). The pid file it writes is still how the healthcheck finds it, since `init: true` means the
# server is not PID 1.
CMD ["node", "/app/api.mjs"]

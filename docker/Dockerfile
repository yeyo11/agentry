# syntax=docker/dockerfile:1

# The API is compiled here and only the result is shipped. esbuild turns each entrypoint into a
# self-contained ESM file (apps/api/scripts/bundle.mjs), so the image that runs it carries no
# source tree, no node_modules and no transpiler: the container used to start `tsx src/index.ts`
# and parse the whole of TypeScript on every boot.
FROM node:26-bookworm-slim AS build
# Node 25 stopped shipping corepack, so pnpm comes from npm, pinned to the root packageManager.
RUN npm install -g pnpm@10.17.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY packages/ui/package.json packages/ui/
COPY packages/chat-ui/package.json packages/chat-ui/
COPY packages/mcp/package.json packages/mcp/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps apps
RUN pnpm --filter @agentry/web build \
 && pnpm --filter @agentry/api bundle

FROM node:26-bookworm-slim

# Tools Claude Code relies on when working inside projects (openssh-client is git's, over ssh).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client procps ripgrep jq python3 \
 && rm -rf /var/lib/apt/lists/*

# Nothing here needs pnpm any more: it is left for the projects Claude works on under /workspace,
# which is also why node and python3 stay.
RUN npm install -g pnpm@10.17.1

# The code hosts' own CLIs, which are the only way Agentry reaches GitHub and GitLab
# (docs/code-hosts.md), from the vendors' linux amd64 release tarballs (the image is built for amd64
# only, .github/workflows/image.yml). Pinned to the versions the recordings under
# packages/core/test/fixtures/recordings were made with, for the same reason as the agents below.
# Each tarball is checked twice: the pinned digest must be the vendor's published one for that file,
# and the file must hash to it, so neither a moved release nor a tampered download gets through.
# To bump one, set the version, then take the new digest from the vendor's checksums file:
#   curl -fsSL https://github.com/cli/cli/releases/download/v<v>/gh_<v>_checksums.txt | grep linux_amd64.tar.gz
#   curl -fsSL https://gitlab.com/gitlab-org/cli/-/releases/v<v>/downloads/checksums.txt | grep linux_amd64.tar.gz
# and re-record what the adapters read if the release notes touch it.
ARG GH_VERSION=2.102.0
ARG GH_SHA256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
ARG GLAB_VERSION=1.120.0
ARG GLAB_SHA256=4e6c59de9f7ed2f304bf93aad01ea8f8a69584f0450ce90ad696ef81f69c69aa
RUN set -eu; cd /tmp \
 && gh_tar="gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && curl -fsSL -o "$gh_tar" "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${gh_tar}" \
 && curl -fsSL -o gh-checksums.txt "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" \
 && grep -qx "${GH_SHA256}  ${gh_tar}" gh-checksums.txt \
 && echo "${GH_SHA256}  ${gh_tar}" | sha256sum -c - \
 && tar -xzf "$gh_tar" -C /usr/local/bin --strip-components=2 "gh_${GH_VERSION}_linux_amd64/bin/gh" \
 && glab_tar="glab_${GLAB_VERSION}_linux_amd64.tar.gz" \
 && curl -fsSL -o "$glab_tar" "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/${glab_tar}" \
 && curl -fsSL -o glab-checksums.txt "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/checksums.txt" \
 && grep -qx "${GLAB_SHA256}  ${glab_tar}" glab-checksums.txt \
 && echo "${GLAB_SHA256}  ${glab_tar}" | sha256sum -c - \
 && tar -xzf "$glab_tar" -C /usr/local/bin --strip-components=1 bin/glab \
 && rm -f /tmp/gh* /tmp/glab* \
 && gh --version && glab --version

# Tailscale, for Settings > Remote access (docs/tunnel.md): the host's Tailscale is not visible from
# a container, so the image carries its own CLI and daemon, Tailscale's static linux amd64 build.
# The entrypoint starts tailscaled in userspace networking (no root, no NET_ADMIN, no /dev/net/tun),
# and the person signs it in from the app. Pinned to the version its sign-in was recorded with
# (packages/core/test/fixtures/logins/tailscale-up.*), and checked the same two ways as gh and glab:
# the pinned digest must be the one pkgs.tailscale.com publishes beside the file, and the file must
# hash to it. To bump it, set the version and take the digest from
#   curl -fsSL https://pkgs.tailscale.com/stable/tailscale_<v>_amd64.tgz.sha256
# /run/tailscale holds the daemon's socket where the CLI looks by default, so neither Agentry nor
# anyone else passes --socket; it belongs to the user tailscaled runs as (/var/run is /run here).
ARG TAILSCALE_VERSION=1.102.4
ARG TAILSCALE_SHA256=50748df1045e60b5b695f19f4c56b0da36c019948b440fb456b6584a50f0d8b9
RUN set -eu; cd /tmp \
 && ts_tar="tailscale_${TAILSCALE_VERSION}_amd64.tgz" \
 && curl -fsSL -o "$ts_tar" "https://pkgs.tailscale.com/stable/${ts_tar}" \
 && curl -fsSL -o ts-checksum.txt "https://pkgs.tailscale.com/stable/${ts_tar}.sha256" \
 && [ "$(tr -d '[:space:]' < ts-checksum.txt)" = "${TAILSCALE_SHA256}" ] \
 && echo "${TAILSCALE_SHA256}  ${ts_tar}" | sha256sum -c - \
 && tar -xzf "$ts_tar" -C /usr/local/bin --strip-components=1 "tailscale_${TAILSCALE_VERSION}_amd64/tailscale" "tailscale_${TAILSCALE_VERSION}_amd64/tailscaled" \
 && rm -f /tmp/tailscale_* /tmp/ts-checksum.txt \
 && tailscale version && tailscaled --version \
 && mkdir -p /run/tailscale && chown node:node /run/tailscale

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

# The other agents Agentry can drive, pinned like Claude Code and for the same reason, each to a
# version inside the range its manifest declares (packages/core/src/providers/*/manifest.ts): a
# newer one is a driver change, so a rebuild must not move to it by accident. They go to a prefix of
# their own in the image, which is on the PATH and where the provider detector looks anyway; what a
# person installs later with `npm -g` goes to the same place and lives as long as the container.
# Override with --build-arg <NAME>_VERSION=<version>. JetBrains' `youtrack-app`, the only way
# Agentry reaches YouTrack (docs/trackers.md), comes the same way, pinned to the version its
# recordings were made with.
ARG CODEX_VERSION=0.159.3
ARG GEMINI_CLI_VERSION=0.62.0
ARG COPILOT_VERSION=1.0.93
ARG OPENCODE_VERSION=1.18.35
ARG YOUTRACK_APP_VERSION=1.0.3
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=/home/node/.npm-global/bin:$PATH
RUN npm install -g \
      @openai/codex@${CODEX_VERSION} \
      @google/gemini-cli@${GEMINI_CLI_VERSION} \
      @github/copilot@${COPILOT_VERSION} \
      opencode-ai@${OPENCODE_VERSION} \
      @jetbrains/youtrack-apps-tools@${YOUTRACK_APP_VERSION} \
 && npm cache clean --force \
 && codex --version && gemini --version && copilot --version && opencode --version \
 && youtrack-app --version

WORKDIR /app
# The whole of the wrapper: one JavaScript file, the assistant's MCP server beside it, and the built UI
COPY --from=build --chown=node:node /app/apps/api/dist/api.mjs /app/api.mjs
COPY --from=build --chown=node:node /app/apps/api/dist/mcp.mjs /app/mcp.mjs
COPY --from=build --chown=node:node /app/apps/web/dist /app/web

# Keeping .claude.json inside the config dir means one volume persists the whole account setup.
# AGENTRY_DISTRIBUTION tells the UI that an update here is a new image, not something it can install.
# The tunnel is on by default because the entrypoint runs a tailscaled of Agentry's own; it reaches
# the server on 127.0.0.1, around the published port and the operator's proxy, which is why
# AGENTRY_TUNNEL=off turns it, and that daemon, off (docs/deploy.md, "The tunnel in Docker").
ENV NODE_ENV=production \
    AGENTRY_PID_FILE=/tmp/agentry.pid \
    PORT=8787 \
    HOST=0.0.0.0 \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    AGENTRY_WORKSPACE_DIR=/workspace \
    AGENTRY_DATA_DIR=/data \
    AGENTRY_DEFAULT_PERMISSION_MODE=bypassPermissions \
    DISABLE_AUTOUPDATER=1 \
    AGENTRY_WEB_DIST=/app/web \
    AGENTRY_DISTRIBUTION=docker \
    # Where each agent keeps its sign-in, settings and sessions, moved under /data so the one volume
    # that holds the wrapper's state holds them too: in their default homes (~/.codex, ~/.gemini,
    # ~/.copilot, ~/.config/opencode...) they would be gone with the container, and so would every
    # login. The server creates these folders on start (Codex refuses a home that does not exist).
    CODEX_HOME=/data/provider-homes/codex \
    GEMINI_CLI_HOME=/data/provider-homes/gemini \
    COPILOT_HOME=/data/provider-homes/copilot \
    XDG_CONFIG_HOME=/data/provider-homes/xdg/config \
    XDG_DATA_HOME=/data/provider-homes/xdg/data \
    # gh and glab keep their sign-ins in their config folders, in plain text where there is no
    # keyring (no container has one): on the volume, and nowhere else
    GH_CONFIG_DIR=/data/provider-homes/gh \
    GLAB_CONFIG_DIR=/data/provider-homes/glab \
    # pnpm would put its store under XDG_DATA_HOME, which is now the volume: it stays in the image
    npm_config_store_dir=/home/node/.local/share/pnpm-store

EXPOSE 8787
VOLUME ["/home/node/.claude", "/workspace", "/data"]

# The script also ends the server after a few failed probes, which is what makes a restart policy
# act on an unhealthy container (see docs/deploy.md)
COPY --chown=node:node --chmod=755 docker/healthcheck.sh /app/healthcheck.sh
COPY --chown=node:node --chmod=755 docker/entrypoint.sh /app/entrypoint.sh
HEALTHCHECK --interval=30s --timeout=15s --start-period=20s --retries=3 \
  CMD ["/app/healthcheck.sh"]

# Exec form with no package manager in between: `docker stop` signals the server itself, so the
# container's exit status is the server's (0) and not a package manager's report of a killed child
# (143). The pid file it writes is still how the healthcheck finds it, since `init: true` means the
# server is not PID 1. The entrypoint starts tailscaled, then execs this command, so the server is
# still what the signal reaches.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "/app/api.mjs"]

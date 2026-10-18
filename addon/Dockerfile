# syntax=docker/dockerfile:1
# Built by CI from the repo root:  docker buildx build -f addon/Dockerfile .
# Nothing is compiled, in CI or on the device: the native modules
# (better-sqlite3, argon2) ship prebuilt linux-arm64 and linux-x64 binaries,
# so the build stage runs once on the CI runner's own platform and both
# images copy the same output.

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.34.7 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# The Signal K simulator is a dev dependency of the server: needed for the
# frozen install, left out of the image by `deploy --prod`.
COPY apps/sim/package.json apps/sim/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @watchkeeper/server build \
 && pnpm --filter @watchkeeper/web build \
 && pnpm --filter @watchkeeper/server deploy --legacy --prod /out/server \
 && rm -rf /out/server/src /out/server/test /out/server/scripts \
 && cp -r apps/server/dist /out/server/dist \
 && cp -r apps/web/dist /out/web

FROM node:22-bookworm-slim
ARG BUILD_VERSION=0.1.0
ARG BUILD_ARCH
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/server /app/server
COPY --from=build /out/web /app/web
COPY addon/run.sh /run.sh
COPY addon/data-hub-snapshot /usr/bin/data-hub-snapshot
RUN chmod +x /run.sh /usr/bin/data-hub-snapshot
LABEL io.hass.type="addon" io.hass.version="${BUILD_VERSION}" io.hass.arch="${BUILD_ARCH}" \
      org.opencontainers.image.source="https://github.com/av8rboie/WatchKeeper"
CMD ["/run.sh"]

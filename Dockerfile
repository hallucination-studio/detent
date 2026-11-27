FROM node:22-slim AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/delivery/package.json packages/delivery/

FROM manifests AS builder
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY packages/ packages/
RUN npm run build

FROM --platform=$BUILDPLATFORM node:22-slim AS helm
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# Archive hashes from the Helm v3.17.2 release.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) checksum=90c28792a1eb5fb0b50028e39ebf826531ebfcf73f599050dbd79bab2f277241 ;; \
      arm64) checksum=d78d76ec7625a94991e887ac049d93f44bd70e4876200b945f813c9e1ed1df7c ;; \
      *) echo "Unsupported Helm architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://get.helm.sh/helm-v3.17.2-linux-${TARGETARCH}.tar.gz" -o /tmp/helm.tar.gz; \
    echo "$checksum  /tmp/helm.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/helm.tar.gz --strip-components=1 -C /usr/local/bin "linux-${TARGETARCH}/helm"; \
    rm /tmp/helm.tar.gz

FROM manifests AS runtime
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates yamllint \
    && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=helm /usr/local/bin/helm /usr/local/bin/helm
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/delivery/dist packages/delivery/dist
COPY scripts/bootstrap.ts scripts/
COPY examples/hub-workspace/ examples/hub-workspace/
COPY .env.example ./
RUN install -d -o node -g node /tmp/detent-sandboxes
USER node
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/delivery/dist/server.js"]

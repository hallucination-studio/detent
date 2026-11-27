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

FROM manifests AS runtime
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/delivery/dist packages/delivery/dist
COPY scripts/bootstrap.ts scripts/smoke-live.mjs scripts/
COPY examples/hub-workspace/ examples/hub-workspace/
COPY .env.example ./
RUN install -d -o node -g node /tmp/detent-sandboxes
USER node
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/delivery/dist/server.js"]

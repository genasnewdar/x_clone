# syntax=docker/dockerfile:1
# One image for both targets (Compute Engine VM and Cloud Run).

# ---- Build the web UI ---------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- Build the server -----------------------------------------------------------
FROM node:22-alpine AS server
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

# ---- Runtime ---------------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS=--max-old-space-size=384
WORKDIR /app/server
COPY --from=server /src/server/node_modules ./node_modules
COPY --from=server /src/server/dist ./dist
COPY server/package.json server/AGENT_GUIDE.md ./
COPY server/migrations ./migrations
COPY --from=web /src/web/dist /app/web/dist
# Run as the unprivileged "node" user; nothing in the image is writable by it.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "dist/server.js"]

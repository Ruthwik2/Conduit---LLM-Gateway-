# Conduit — self-hostable, OpenAI-compatible LLM gateway.
#
# We run the TypeScript sources directly with tsx (the same runtime used in dev),
# which keeps the image simple and the source debuggable. The app is stateless;
# all durable state lives in Redis and Postgres.

FROM node:22-slim

WORKDIR /app

# Install dependencies first for better layer caching. `npm ci` against the
# committed lockfile gives reproducible builds; we include devDependencies
# because tsx (the runtime loader) lives there.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

# Application source. Config is mounted at runtime (see docker-compose.yml); if no
# config file is present the server boots a zero-config default (mock providers).
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# The gateway needs no root privileges; drop to the unprivileged user the base
# image ships with.
USER node

# Liveness/readiness for orchestrators. Uses Node's global fetch (Node 18+).
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node_modules/.bin/tsx", "src/server.ts"]

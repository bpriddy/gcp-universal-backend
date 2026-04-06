# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --ignore-scripts

# Generate Prisma client
RUN npx prisma generate

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

# Install OpenSSL + curl for Prisma engine and healthcheck
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssl curl && rm -rf /var/lib/apt/lists/*

# Create a non-root user for the process
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nodeuser

# Copy only production artifacts
COPY --from=builder --chown=nodeuser:nodejs /app/dist ./dist
COPY --from=builder --chown=nodeuser:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodeuser:nodejs /app/package.json ./
# prisma/ is required by the migration job (prisma migrate deploy)
COPY --from=builder --chown=nodeuser:nodejs /app/prisma ./prisma

# Run as non-root
USER nodeuser

EXPOSE 3000

# Healthcheck for Cloud Run / K8s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3000/health/live || exit 1

CMD ["node", "dist/server.js"]

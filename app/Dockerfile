# Barnaba Node.js Gateway
# =======================
# Multi-stage build for optimized production image

# Stage 1: Dependencies
# Node 20 reached end of life on 30 April 2026; 24 is the current LTS.
#
# PINNED BY DIGEST, and the tag is `24-bookworm` rather than `1-24-bookworm`:
# the `1-` family of this image never had a Node 24 variant, so the obvious
# edit would have pointed the build at a tag that does not exist. Resolved
# against mcr.microsoft.com rather than assumed.
ARG NODE_BASE_IMAGE=mcr.microsoft.com/devcontainers/javascript-node:24-bookworm@sha256:fe599ef9d866c4adb1fbb1f8a37af2892a090e5fd0d93feb8471e9de15a5f14d
FROM ${NODE_BASE_IMAGE} AS deps

WORKDIR /app

# Copy only the gateway dependency contract. `package*.json` also matched the
# control-plane manifest/lockfile, silently widening this image's build input.
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Stage 2: Production
FROM ${NODE_BASE_IMAGE} AS production

# Install ffmpeg for audio decoding (WebM → PCM conversion)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Security: Run as non-root user
RUN groupadd -r barnaba && useradd -r -g barnaba barnaba

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY . .

# SW cache id derived from the CONTENT of public/, not from the clock.
# A timestamp makes every build of the same commit a different image, which
# is the opposite of what the rest of this repository spends its effort on:
# the provenance marker, the pinned model revision, the lockfiles. Same
# sources in, same cache name out - and a real change still busts the cache.
RUN CACHE_ID=$(find public -type f -exec sha256sum {} + | sort | sha256sum | cut -c1-12) && \
    sed -i "s/barnabas-[a-z0-9-]*/barnabas-$CACHE_ID/" public/sw.js

# Set ownership
RUN chown -R barnaba:barnaba /app

# Switch to non-root user
USER barnaba

# Environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://localhost:8080/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start the server
CMD ["node", "server.js"]

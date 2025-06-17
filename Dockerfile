# Monad Validator Analytics - Production Dockerfile
# Multi-stage build for optimized production image

# =============================================
# Build Stage
# =============================================
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Install build dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    curl

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy source code
COPY src/ ./src/
COPY database/ ./database/

# Build the application
RUN npm run build

# =============================================
# Production Stage
# =============================================
FROM node:18-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache \
    systemd \
    util-linux \
    curl \
    dumb-init \
    tzdata

# Create non-root user
RUN addgroup -g 1001 -S monad && \
    adduser -S monad -u 1001 -G monad

# Set working directory
WORKDIR /app

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/database ./database

# Copy additional production files
COPY examples/ ./examples/
COPY .env.example ./.env

# Create necessary directories
RUN mkdir -p /app/logs /app/data && \
    chown -R monad:monad /app

# Switch to non-root user
USER monad

# Expose ports
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "dist/index.js"] 
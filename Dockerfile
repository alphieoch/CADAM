# Multi-stage build for CADAM - TanStack Start + Nitro app

# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (use npm install instead of npm ci for flexibility)
RUN npm install

# Copy source code
COPY . .

# Force route tree regeneration to pick up new routes
RUN rm -f src/routeTree.gen.ts

# Build the application (vite build auto-generates TanStack Router routes)
RUN npx vite build

# Stage 2: Production
FROM node:22-alpine AS runner

WORKDIR /app

# Copy built application from builder
COPY --from=builder /app/.output ./.output

# Set environment variables
ENV NODE_ENV=production
ENV NITRO_PORT=3000

# Expose the port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/cadam/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# Start the server
CMD ["node", ".output/server/index.mjs"]

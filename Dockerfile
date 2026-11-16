# Build stage: install everything, compile the Tailwind CSS, then drop the dev dependencies.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:css && npm prune --omit=dev

# Runtime stage: production dependencies only, plus pg_dump for `npm run backup`.
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]

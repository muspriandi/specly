# Build stage: install everything, compile the Tailwind CSS, then drop the dev dependencies.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:css && npm prune --omit=dev

# Runtime stage: production dependencies only, plus pg_dump for scripts/backup.js. Alpine keeps the package count (and so the
# list of possible CVEs) small; `apk upgrade` pulls in security fixes released since the base image was built. npm and corepack
# are removed: nothing at runtime needs them, and the npm CLI carries dependencies of its own that are scanned too.
FROM node:26-alpine
RUN apk upgrade --no-cache && apk add --no-cache postgresql-client \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]

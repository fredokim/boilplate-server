# syntax=docker/dockerfile:1

# The API only.
#
# This image used to carry the React client as well, because the refresh cookie
# is `sameSite: lax` and the browser had to see one origin. Now that three
# frontends share this backend, each one proxies `/api` to it instead — the
# browser still sees a single origin, and this image stays framework-agnostic.
# See DEPLOYMENT.md.

FROM node:22-alpine AS build
WORKDIR /app

# Dependencies before source, so a source-only change does not invalidate the
# install layer. --ignore-scripts skips the postinstall `prisma generate`, run
# below once the schema is definitely present.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts

COPY . .
RUN npx prisma generate
RUN npm run build


FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Production dependencies only. The build toolchain, the test runner, and the
# Prisma CLI stay behind in the build stage.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# dist carries the compiled server and, via the nest-cli assets entry, the
# generated Prisma client and its native query engine.
COPY --from=build /app/dist ./dist
# Migrations travel with the image so `prisma migrate deploy` can run as a
# separate deployment step against the same version being released.
COPY --from=build /app/prisma ./prisma

# The node image ships a non-root `node` user. Running as root would mean a
# container escape starts with root, for no benefit.
USER node

EXPOSE 3001

# Liveness only — readiness depends on the database, and a container that is
# healthy but not ready is exactly the state a rolling deploy needs to see.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No migration on startup. See DEPLOYMENT.md: a container that migrates as it
# boots turns a rolling deploy into several concurrent migrations.
CMD ["node", "dist/main.js"]

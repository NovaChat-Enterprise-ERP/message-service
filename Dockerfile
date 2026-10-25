# syntax=docker/dockerfile:1.7
# Needs an .npmrc with a read:packages token for GitHub Packages:
#   docker build --secret id=npmrc,src=$HOME/.npmrc -t novachat/message-service .
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS base
RUN apk add --no-cache libc6-compat && corepack enable
WORKDIR /app

FROM base AS builder
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs novachat
COPY --from=builder --chown=novachat:nodejs /app/package.json ./
COPY --from=builder --chown=novachat:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=novachat:nodejs /app/dist ./dist
COPY --from=builder --chown=novachat:nodejs /app/drizzle ./drizzle
USER novachat
CMD ["node", "dist/server.js"]

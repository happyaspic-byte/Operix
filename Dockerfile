FROM node:26-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:26-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:26-bookworm-slim AS runner
LABEL org.opencontainers.image.source="https://github.com/happyaspic-byte/Operix"
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src/lib ./src/lib
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/tsconfig.json ./tsconfig.json
RUN mkdir -p /app/storage/uploads /app/storage/security && chown -R node:node /app/storage
USER node
EXPOSE 3000
CMD ["node", "--import", "./scripts/runtime-guard.mjs", "server.js"]

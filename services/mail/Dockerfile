# Takumo inbound mail (SMTP -> signed webhook). Build from services/mail:
#   docker build -t takumo-mail services/mail
# node:22-alpine is multi-arch, so this builds natively on the ARM64 VM.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=2525 \
    HEALTH_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Unprivileged; compose may run it as the caddy user's uid to read the certificate.
USER node
EXPOSE 2525
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:2526/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]

# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────────────
# raiz-relayer — imagen de producción (Fly.io / cualquier runtime Docker).
#
# Multi-stage: la etapa `build` compila TypeScript con las devDependencies; la
# etapa `runtime` solo lleva dependencias de producción, dist/ y config/.
# No hay secretos aquí ni en la imagen: RELAYER_ADMIN_SECRET y RELAYER_APP_KEY
# llegan SIEMPRE por variables de entorno en tiempo de ejecución.
# ──────────────────────────────────────────────────────────────────────────────

# ── Etapa 1: build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Etapa 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080

# Solo dependencias de producción (sin tsx, vitest, typescript…).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# deployments.testnet.json: IDs de contratos + G… pública del admin (no es secreto).
COPY config ./config

# Nunca root. La imagen oficial trae el usuario `node` (uid 1000).
RUN chown -R node:node /app
USER node

EXPOSE 8080

# Liveness: /v1/live no toca la red (200 mientras el proceso responda). NO usar
# /v1/health: da 503 cuando cae Stellar y el runtime reiniciaría un relayer sano.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/v1/live || exit 1

CMD ["node", "dist/index.js"]

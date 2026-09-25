# Imagem de producao.
#
# node:22 slim (Debian) e nao alpine de proposito: o sharp baixa binario
# pronto pra glibc, e no alpine (musl) ele teria que compilar libvips no
# build - minutos a mais e uma fonte de erro que nao paga o disco economizado.
FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./

# --omit=dev deixa o PGlite de fora: em producao o banco e Postgres de verdade,
# e o WASM dele sozinho pesa mais que o resto do app junto.
RUN npm ci --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Roda como usuario sem privilegio: se alguem escapar do processo, nao cai em root.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts

USER node
EXPOSE 3000

# O proprio app aplica as migrations ao subir, entao deploy nao tem passo extra.
CMD ["node", "src/server.js"]

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && npm ci --no-audit --no-fund && apt-get purge -y --auto-remove python3 make g++ && rm -rf /var/lib/apt/lists/*
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY --from=build --chown=node:node /app ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "--", "-H", "0.0.0.0"]

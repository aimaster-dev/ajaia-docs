# ---- build: install everything, build client + server, then drop dev deps
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime: just the compiled app and production dependencies
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/ajaia-docs.db
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/server/index.js"]

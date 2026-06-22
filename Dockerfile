# --- build stage ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ---
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# 0.0.0.0 so the container is reachable via its published port — binding to
# loopback would make the relay unreachable from outside the container.
ENV RELAY_HOST=0.0.0.0
ENV RELAY_PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${RELAY_PORT}/health" || exit 1
CMD ["node", "dist/index.js"]

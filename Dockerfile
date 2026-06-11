# ── Build stage: compile the React dashboard ──
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Runtime: API server + built dashboard in one container ──
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY serverlib ./serverlib
COPY --from=build /app/dist ./dist
ENV PORT=3001 BIND_HOST=0.0.0.0 DATA_DIR=/app/data
EXPOSE 3001
CMD ["node", "server.js"]

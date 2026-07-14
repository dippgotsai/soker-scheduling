# 門市排班系統 — Railway / Docker 部署
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# SQLite 資料檔放在 /data（Railway 請掛載 Volume 到 /data）
ENV DATABASE_PATH=/data/app.db
RUN mkdir -p /data
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]

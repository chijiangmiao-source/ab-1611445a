FROM node:20-alpine

WORKDIR /app

# 零运行时第三方依赖：仅复制应用与验收代码
COPY package.json ./
COPY src ./src
COPY public ./public
COPY verify ./verify

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

RUN mkdir -p /data && node --check src/server.js && node --check src/store.js

EXPOSE 8080

CMD ["node", "src/server.js"]

# SitePanel: панель + реверс-прокси 80/443 в одном контейнере.
# Контекст сборки — корень репозитория:
#   docker build -f deploy/Dockerfile -t sitepanel .
# или через compose (см. deploy/docker-compose.yml):
#   docker compose -f deploy/docker-compose.yml up -d --build

FROM node:22-alpine

# `script` из util-linux — fallback-PTY веб-терминала: node-pty (optional-зависимость,
# нативный модуль) в образе не ставится — компилятора нет; без `script` терминал
# оставался бы в raw-режиме (без нормального ресайза).
RUN apk add --no-cache util-linux

WORKDIR /app
ENV NODE_ENV=production \
    PANEL_DATA_DIR=/app/data

# Зависимости отдельным слоем: правки кода не инвалидируют кэш npm ci.
# --omit=optional пропускает node-pty (нативный, в контейнере заменён `script`),
# --omit=dev — линтер, тесты и playwright.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY src ./src

# data/ заранее с владельцем node: пустой named volume при первом подключении
# наследует владельца каталога из образа — иначе панель под непривилегированным
# пользователем не смогла бы писать в том.
RUN mkdir -p /app/data && chown -R node:node /app

# Порты 80/443 под непривилегированным пользователем требуют дополнительной
# возможности ядра: cap_add: [NET_BIND_SERVICE] в docker-compose.yml.
USER node

EXPOSE 80 443 3000

# Панель сама отвечает на /healthz без авторизации (см. src/index.js).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PANEL_ADMIN_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]

# Образ для бота РУКА (local-runner). Код репозитория не копируется внутрь —
# он монтируется томом (volume) в docker-compose.yml, чтобы контейнер видел
# тот же config.json и уже настроенный git (для git push), что и сама папка
# на сервере.
FROM node:20-alpine

RUN apk add --no-cache git openssh-client

WORKDIR /app

CMD ["node", "local-runner/ruka-telegram-bot.mjs"]

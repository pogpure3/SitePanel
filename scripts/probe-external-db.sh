#!/usr/bin/env bash
# Диагностика внешней БД 92.101.71.244:5432 (задача 7.2 / I-05 плана).
#
# Аудит 2026-10-12: TCP-соединение НЕ устанавливается ни с нового стенда
# (141.133.197.43), ни со старого (46.29.164.250) — приложение pg поднимается,
# но запросы к БД работать не будут. Скрипт локализует, ГДЕ режется:
# с этого хоста, из этой сети, по этому порту.
#
# Запуск на каждом стенде: bash probe-external-db.sh [host] [port]

set -uo pipefail
HOST="${1:-92.101.71.244}"
PORT="${2:-5432}"

echo "Проба $HOST:$PORT с $(hostname) ($(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo 'внешний IP не определён'))"

# 1. TCP-доступность с таймаутом 5с.
if timeout 5 bash -c "</dev/tcp/$HOST/$PORT" 2>/dev/null; then
  echo "TCP: ОТКРЫТ"
else
  echo "TCP: НЕ ОТВЕЧАЕТ (таймаут/фильтр)"
fi

# 2. Трасса до цели: где пропадает.
echo "--- traceroute (до 15 хопов) ---"
traceroute -n -m 15 -w 2 "$HOST" 2>/dev/null || tracepath -n -m 15 "$HOST" 2>/dev/null || echo "traceroute/tracepath недоступны"

# 3. Если TCP вдруг открыт — handshake PostgreSQL (в ответе видна версия).
if timeout 5 bash -c "</dev/tcp/$HOST/$PORT" 2>/dev/null; then
  printf '\x00\x00\x00\x08\x04\xd2\x16\x2f' | timeout 5 nc "$HOST" "$PORT" | head -c 64 | xxd | head -4
  echo "(ожидался ответ SSL-неготиации: 'S' или 'N')"
fi

echo "Интерпретация: TCP закрыт с обеих сторон = файрвол/белый список на стороне БД.
Владельцу БД: открыть $PORT для внешних IP обоих стендов либо перенести БД на стенд."

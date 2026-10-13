#!/usr/bin/env bash
# Бэкап данных SitePanel (задача 7.3 / I-06 плана).
#
# Запускается на стенде от root: копирует db.json (+ .bak), auth.json,
# state.json, сертификаты и ключи ACME в /root/sitepanel-backups/<ts>/,
# права 0600/0700, хранение по умолчанию 14 дней.
#
# Установка:
#   scp scripts/backup-sitepanel.sh root@<стенд>:/usr/local/sbin/
#   chmod 700 /usr/local/sbin/backup-sitepanel.sh
#   crontab -e:
#     30 4 * * * /usr/local/sbin/backup-sitepanel.sh >> /var/log/sitepanel-backup.log 2>&1
#
# Панель НЕ останавливается: db.json пишется атомарно (tmp+rename), копия
# получает либо прежнюю, либо новую версию целиком; на случай попадания в окно
# записи рядом копируется и db.json.bak (предыдущее поколение).

set -euo pipefail

DATA_DIR="${PANEL_DATA_DIR:-/opt/sitepanel/data}"
DEST_ROOT="${PANEL_BACKUP_ROOT:-/root/sitepanel-backups}"
RETAIN_DAYS="${PANEL_BACKUP_RETAIN_DAYS:-14}"

TS="$(date +%Y%m%d-%H%M%S)"
DEST="$DEST_ROOT/$TS"

mkdir -p "$DEST"
chmod 700 "$DEST_ROOT" "$DEST"

fail=0
copy_secret() { # <src> <dest-имя>
  if [ -f "$1" ]; then
    install -m 0600 "$1" "$DEST/$2"
    echo "  + $2"
  else
    echo "  ! нет файла: $1" >&2
  fi
}

echo "[backup] $TS -> $DEST"
copy_secret "$DATA_DIR/db.json" "db.json"
copy_secret "$DATA_DIR/db.json.bak" "db.json.bak"
copy_secret "$DATA_DIR/auth.json" "auth.json"
copy_secret "$DATA_DIR/state.json" "state.json"

for dir in certs acme; do
  if [ -d "$DATA_DIR/$dir" ]; then
    cp -r "$DATA_DIR/$dir" "$DEST/$dir"
    chmod -R go-rwx "$DEST/$dir"
    echo "  + $dir/ ($(find "$DEST/$dir" -type f | wc -l) файлов)"
  fi
done

# Контроль: архив без db.json бесполезен — считаем такую попытку ошибкой.
if [ ! -f "$DEST/db.json" ] && [ ! -f "$DEST/db.json.bak" ]; then
  echo "[backup] ОШИБКА: ни db.json, ни db.json.bak не скопированы" >&2
  fail=1
fi

# Ротация: удаляем копии старше RETAIN_DAYS.
find "$DEST_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETAIN_DAYS" -exec rm -rf {} + 2>/dev/null || true

echo "[backup] готово: $DEST (хранение ${RETAIN_DAYS} дн.)"
exit "$fail"

#!/usr/bin/env bash
# Усиление старого стенда 46.29.164.250 (задача 7.1 / I-04 плана).
#
# ПРИМЕНЁН 2026-10-14 (см. WORKLOG). Оставлен для воспроизведения на новом
# развёртывании. Нюансы, выявленные при применении:
#   - файл обязан называться 01-…: sshd берёт ПЕРВОЕ значение параметра,
#     и 50-cloud-init.conf (PasswordAuthentication yes) молча перекрывал бы
#     файл с большим номером;
#   - на стенде был мёртвый PPA certbot/certbot (нет Release для noble,
#     certbot стоит из noble/universe) — apt-get update падал, из-за `&&`
#     не выполнялась установка fail2ban; PPA отключён, шаг update сделан
#     нефатальным.
#
# Перед запуском:
#   1. Убедиться, что есть работающий доступ по ключу И консоль провайдера
#      (VNC) на случай блокировки.
#   2. Держать ОТКРЫТОЙ вторую ssh-сессию до конца проверки.
#   3. Запускать под root: bash harden-old-stand.sh
#
# Что делает (зеркало нового стенда 141.133.197.43, см. WORKLOG 2026-10-12):
#   - sshd: root только по ключу, пароли выключены ( /etc/ssh/sshd_config.d/01-hardening.conf);
#   - UFW: разрешить 22/80/443, всё прочее запретить;
#   - fail2ban: sshd-jail;
#   - swap 2 ГБ (RAM 1962 МБ, swap 0 — риск OOM при npm install сайтов).
#
# После выполнения ОБЯЗАТЕЛЬНО, не выходя из текущей сессии:
#   ssh -o PasswordAuthentication=no root@46.29.164.250 'echo ok'
#   systemctl is-active ufw fail2ban; free -h; nginx -t

set -uo pipefail
stamp="$(date +%Y%m%d-%H%M%S)"
bak() { # <файл> — копия рядом, путь в журнал
  [ -f "$1" ] && cp -a "$1" "$1.bak.$stamp" && echo "[backup] $1 -> $1.bak.$stamp"
}

echo "=== 1/4 sshd: только ключи ==="
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/01-hardening.conf <<'EOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
PubkeyAuthentication yes
EOF
bak /etc/ssh/sshd_config
sshd -t && systemctl reload ssh || { echo "sshd -t НЕ ПРОШЁЛ — проверьте конфиг, reload не применён"; }

echo "=== 2/4 UFW: 22/80/443 ==="
if command -v ufw >/dev/null; then
  ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp
  ufw --force enable
  ufw status verbose
else
  echo "ufw не установлен — пропущено"
fi

echo "=== 3/4 fail2ban (sshd) ==="
if ! command -v fail2ban-client >/dev/null; then
  apt-get update -qq || true # падение одного репо (например, мёртвого PPA) не должно мешать установке
  apt-get install -y -qq fail2ban
fi
systemctl enable --now fail2ban
fail2ban-client status sshd || true

echo "=== 4/4 swap 2G ==="
if [ ! -f /swapfile ]; then
  bak /etc/fstab
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Умеренный своп: память сначала заканчивают приложения, кэш — вторым.
  printf 'vm.swappiness=10\nvm.vfs_cache_pressure=50\n' > /etc/sysctl.d/99-sitepanel.conf
  sysctl --system >/dev/null
else
  echo "swapfile уже существует — пропущено"
fi
free -h

echo "=== ГОТОВО. Проверьте доступ ВТОРОЙ сессией, не закрывая эту. ==="

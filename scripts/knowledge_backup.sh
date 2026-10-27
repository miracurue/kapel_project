#!/usr/bin/env bash
# Резервная копия хранилища знаний (Postgres: схемы med, clinrec и служебные таблицы) вместе с векторами.
# Копия самодостаточна: на другом сервере её можно развернуть без повторного вызова GigaChat
# (knowledge_restore.sh). Формат pg_dump custom (-Fc), сжатие zstd.
#
# Режимы подключения (выберите один):
#   KNOWLEDGE_DB_CONTAINER=<имя контейнера>  pg_dump выполняется внутри контейнера (docker exec), по сокету;
#                                            на сервере: $(docker compose -f deploy/compose.server.yml ps -q knowledge-db)
#   KNOWLEDGE_DATABASE_URL=postgres://...    нужен pg_dump (клиент postgresql-client-17) на машине
# Прочее: KNOWLEDGE_DB_NAME (knowledge), KNOWLEDGE_DB_USER (knowledge),
#         KNOWLEDGE_BACKUP_DIR (./backups/knowledge), KNOWLEDGE_BACKUP_KEEP (7 последних копий).
# Код возврата 0 — копия записана и проверена (pg_restore --list, sha256).
set -euo pipefail

name="${KNOWLEDGE_DB_NAME:-knowledge}"
user="${KNOWLEDGE_DB_USER:-knowledge}"
dir="${KNOWLEDGE_BACKUP_DIR:-./backups/knowledge}"
keep="${KNOWLEDGE_BACKUP_KEEP:-7}"
container="${KNOWLEDGE_DB_CONTAINER:-}"

case "$keep" in ''|*[!0-9]*) echo "KNOWLEDGE_BACKUP_KEEP должно быть числом" >&2; exit 2;; esac
if [ -z "$container" ] && [ -z "${KNOWLEDGE_DATABASE_URL:-}" ]; then
  echo "Задайте KNOWLEDGE_DB_CONTAINER или KNOWLEDGE_DATABASE_URL" >&2
  exit 2
fi

pg() { # pg <команда> [аргументы]: выполняет клиентскую утилиту Postgres в выбранном режиме
  local cmd="$1"; shift
  if [ -n "$container" ]; then docker exec -i "$container" "$cmd" -U "$user" "$@"; else "$cmd" "$@"; fi
}
target() { if [ -n "$container" ]; then printf '%s\n' "-d" "$name"; else printf '%s\n' "-d" "$KNOWLEDGE_DATABASE_URL"; fi; }

mkdir -p "$dir"
chmod 700 "$dir" 2>/dev/null || true
stamp="$(date -u +%Y%m%d-%H%M%S)"
file="$dir/knowledge-$stamp.dump"
tmp="$file.partial"
trap 'rm -f "$tmp"' EXIT

started=$(date +%s)
mapfile -t tgt < <(target)
# --no-owner/--no-acl: копия переносима между серверами с другим паролем и ролями.
pg pg_dump "${tgt[@]}" --format=custom --compress=zstd:3 --no-owner --no-acl > "$tmp"
# Проверка читаемости оглавления (внутри контейнера/клиентом) и непустоты.
if [ -n "$container" ]; then docker exec -i "$container" pg_restore --list < "$tmp" > /dev/null
else pg_restore --list "$tmp" > /dev/null; fi
mv "$tmp" "$file"
( cd "$dir" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256" )
chmod 600 "$file" "$file.sha256" 2>/dev/null || true

# Ротация: оставить последние $keep копий.
ls -1 "$dir"/knowledge-*.dump 2>/dev/null | sort | head -n "-$keep" | while read -r old; do rm -f "$old" "$old.sha256"; done

size=$(du -h "$file" | cut -f1)
echo "OK $file ($size, $(( $(date +%s) - started )) с)"

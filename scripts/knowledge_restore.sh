#!/usr/bin/env bash
# Восстановление хранилища знаний из копии knowledge_backup.sh (с векторами, без обращения к GigaChat).
# HNSW-индексы при восстановлении строятся заново (pg_restore создаёт индексы после данных): на корпусе
# ~60 тыс. чанков это основная часть времени. Рекомендуем maintenance_work_mem >= 384MB на сервере.
#
#   KNOWLEDGE_DB_CONTAINER=<контейнер> scripts/knowledge_restore.sh <файл.dump> [--db ИМЯ] [--create] [--clean]
#     --db ИМЯ   целевая БД (по умолчанию KNOWLEDGE_DB_NAME или knowledge)
#     --create   создать БД (ошибка, если уже есть); для проверки копии: --db knowledge_check --create
#     --clean    сначала удалить схемы med и clinrec целевой БД (ДАННЫЕ БУДУТ ПОТЕРЯНЫ); без флага непустая БД отвергается
# Режим без контейнера: KNOWLEDGE_ADMIN_URL=postgres://.../postgres (нужны pg_restore и psql), БД выбирается --db.
# После восстановления выполняются ANALYZE и проверка (число строк и векторов).
set -euo pipefail

dump="${1:-}"; shift || true
[ -n "$dump" ] && [ -f "$dump" ] || { echo "usage: $0 <file.dump> [--db NAME] [--create] [--clean]" >&2; exit 2; }
name="${KNOWLEDGE_DB_NAME:-knowledge}"
user="${KNOWLEDGE_DB_USER:-knowledge}"
container="${KNOWLEDGE_DB_CONTAINER:-}"
create=0; clean=0
while [ $# -gt 0 ]; do
  case "$1" in
    --db) name="${2:?}"; shift 2;;
    --create) create=1; shift;;
    --clean) clean=1; shift;;
    *) echo "неизвестный аргумент $1" >&2; exit 2;;
  esac
done
case "$name" in *[!a-zA-Z0-9_]*|'') echo "имя БД: только буквы, цифры, _" >&2; exit 2;; esac
if [ -z "$container" ] && [ -z "${KNOWLEDGE_ADMIN_URL:-}" ]; then
  echo "Задайте KNOWLEDGE_DB_CONTAINER или KNOWLEDGE_ADMIN_URL" >&2; exit 2
fi

if [ -f "$dump.sha256" ]; then
  ( cd "$(dirname "$dump")" && sha256sum --check --status "$(basename "$dump").sha256" ) || { echo "контрольная сумма не совпала" >&2; exit 3; }
fi

adb() { # psql к служебной БД postgres
  if [ -n "$container" ]; then docker exec -i "$container" psql -U "$user" -d postgres -v ON_ERROR_STOP=1 -tA "$@"
  else psql "$KNOWLEDGE_ADMIN_URL" -v ON_ERROR_STOP=1 -tA "$@"; fi
}
tdb() { # psql к целевой БД
  if [ -n "$container" ]; then docker exec -i "$container" psql -U "$user" -d "$name" -v ON_ERROR_STOP=1 -tA "$@"
  else psql "$(printf '%s' "$KNOWLEDGE_ADMIN_URL" | sed -E "s#/[^/?]*(\?|$)#/$name\1#")" -v ON_ERROR_STOP=1 -tA "$@"; fi
}

exists=$(adb -c "SELECT 1 FROM pg_database WHERE datname = '$name'")
if [ "$create" = 1 ]; then
  [ -z "$exists" ] || { echo "БД $name уже существует" >&2; exit 4; }
  adb -c "CREATE DATABASE $name"
elif [ -z "$exists" ]; then
  echo "БД $name не существует (используйте --create)" >&2; exit 4
else
  has=$(tdb -c "SELECT count(*) FROM pg_namespace WHERE nspname IN ('med','clinrec')")
  if [ "$has" != "0" ]; then
    [ "$clean" = 1 ] || { echo "в БД $name уже есть схемы med/clinrec; добавьте --clean (данные будут удалены)" >&2; exit 4; }
    tdb -c "DROP SCHEMA IF EXISTS med CASCADE; DROP SCHEMA IF EXISTS clinrec CASCADE; DROP TABLE IF EXISTS public.knowledge_meta, public.knowledge_schema_migrations"
  fi
fi

# Параллельная сборка HNSW берёт общую память размером с maintenance_work_mem из /dev/shm (shm_size контейнера);
# при 256m и maintenance_work_mem=384MB она падает, поэтому по умолчанию индексы строятся без параллельных воркеров.
pgopts="${PGOPTIONS:--c max_parallel_maintenance_workers=0}"
started=$(date +%s)
if [ -n "$container" ]; then
  # --single-transaction не используем: индексы HNSW строятся долго, а при сбое достаточно повторить с --clean
  docker exec -i -e PGOPTIONS="$pgopts" "$container" pg_restore -U "$user" -d "$name" --no-owner --no-acl --exit-on-error < "$dump"
else
  tgt="$(printf '%s' "$KNOWLEDGE_ADMIN_URL" | sed -E "s#/[^/?]*(\?|$)#/$name\1#")"
  PGOPTIONS="$pgopts" pg_restore -d "$tgt" --no-owner --no-acl --exit-on-error "$dump"
fi
tdb -c "ANALYZE" > /dev/null
echo "восстановлено за $(( $(date +%s) - started )) с в БД $name"
tdb -F ' ' -c "SELECT 'med.chunks', count(*), count(embedding) FROM med.chunks UNION ALL SELECT 'med.effects', count(*), count(embedding) FROM med.effects UNION ALL SELECT 'clinrec.chunks', count(*), count(embedding) FROM clinrec.chunks UNION ALL SELECT 'migrations', count(*), 0 FROM public.knowledge_schema_migrations"

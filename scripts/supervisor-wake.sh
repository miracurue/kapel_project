#!/usr/bin/env bash
# Будильник супервизора Clinical Compass.
# Запускается по cron. Если живого супервизора нет (нет свежего heartbeat) и на
# .agents/BOARD.md есть незавершённые задачи — запускает новую сессию claude -p,
# которая читает .agents/SUPERVISOR.md и делает один тик. Устойчив к лимитам:
# при быстром падении (лимит) включается backoff, без шторма запусков.
#
# Отключить: crontab -e (удалить строку с supervisor-wake.sh) или создать файл
# .agents/.supervisor.stop — скрипт сразу выйдет.

set -u
REPO="/home/morrigue/REPS/clinical_compass"
AGENTS="$REPO/.agents"
HEARTBEAT="$AGENTS/.supervisor.heartbeat"   # супервизор обновляет каждый тик (touch)
STOPFILE="$AGENTS/.supervisor.stop"
STATE="$AGENTS/.supervisor.wake-state"      # backoff: "<unix-ts-next-allowed> <fail-count>"
LOG="$AGENTS/.supervisor.wake.log"          # локальный, в Git не хранится
RUNLOCK="/tmp/clinical-compass-supervisor-wake.lock"
FRESH_MIN=50          # heartbeat свежее этого — супервизор жив
MAX_TURNS=60          # потолок шагов одного запуска, чтобы не жечь окно впустую
CLAUDE="/home/morrigue/.local/bin/claude"
export PATH="/home/morrigue/.local/bin:/usr/local/bin:/usr/bin:/bin"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

exec 9>"$RUNLOCK"
flock -n 9 || exit 0                      # другой запуск скрипта уже идёт

[ -e "$STOPFILE" ] && exit 0
cd "$REPO" || exit 1

# Есть ли что делать: любая строка задачи не в статусе done.
if ! grep -E '^\| (PM-|W[0-9])' "$AGENTS/BOARD.md" | grep -qvE '\| done \|'; then
  log "всё done — будильник ничего не делает"
  exit 0
fi

# Жив ли супервизор.
if [ -e "$HEARTBEAT" ]; then
  age_min=$(( ( $(date +%s) - $(stat -c %Y "$HEARTBEAT") ) / 60 ))
  [ "$age_min" -lt "$FRESH_MIN" ] && exit 0
fi

# Backoff после недавних быстрых падений.
now=$(date +%s)
next=0; fails=0
[ -e "$STATE" ] && read -r next fails < "$STATE"
if [ "$now" -lt "${next:-0}" ]; then exit 0; fi

log "супервизор не отвечает — запускаю claude -p (fails=$fails)"
start=$now
PROMPT='Ты — супервизор проекта Clinical Compass. Прочитай .agents/SUPERVISOR.md и .agents/BOARD.md и выполни один тик цикла (в начале и в конце тика выполни touch .agents/.supervisor.heartbeat). Работай только в ветках wave*/ и integration, в main и на remote не сливай и не пушь. Состояние сохраняй в Git (коммить только явные пути). Останови тик, когда сделал шаги или упёрся в лимит.'

"$CLAUDE" -p "$PROMPT" \
  --permission-mode acceptEdits \
  --allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Agent" "SendMessage" "ListAgents" "TaskStop" \
    "Bash(git *)" "Bash(npm *)" "Bash(node *)" "Bash(npx *)" "Bash(touch .agents/*)" \
    "Bash(ls *)" "Bash(cat *)" "Bash(mkdir *)" "Bash(grep *)" "Bash(sed *)" \
  --max-turns "$MAX_TURNS" >> "$LOG" 2>&1
rc=$?
dur=$(( $(date +%s) - start ))

if [ "$rc" -ne 0 ] && [ "$dur" -lt 120 ]; then
  # Быстрое падение — вероятно лимит. Экспоненциальный backoff 10 мин … 3 ч.
  fails=$(( fails + 1 ))
  wait_s=$(( 600 * (2 ** (fails > 4 ? 4 : fails - 1)) ))
  [ "$wait_s" -gt 10800 ] && wait_s=10800
  echo "$(( $(date +%s) + wait_s )) $fails" > "$STATE"
  log "быстрое падение rc=$rc за ${dur}с, следующая попытка через ${wait_s}с"
else
  rm -f "$STATE"
  log "запуск завершён rc=$rc за ${dur}с"
fi

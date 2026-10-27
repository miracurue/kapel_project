#!/bin/bash
# Запуск скрипта приёмки A2: a2_run.sh <файл.py> [арг...] (BASE по умолчанию http://localhost:3617)
cd "$(dirname "$0")/../.."
BASE=${BASE:-http://localhost:3617} SHOTS=${SHOTS:-docs/acceptance/A2} PYTHONPATH=scripts/acceptance python3 "$@"

#!/usr/bin/env bash
# Создаёт .env для compose.server.yml на сервере: случайные ключи, права 600.
# Существующий .env не перезаписывает. Ключ GigaChat в скрипт не передаётся:
# добавьте его в .env вручную (GIGACHAT_AUTH_KEY=...), в чат и в Git он не попадает.
set -euo pipefail
cd "$(dirname "$0")"
[ -e .env ] && { echo ".env уже есть, ничего не меняю"; exit 0; }
umask 177
key() { head -c32 /dev/urandom | base64; }
cat > .env <<EOF
SESSION_SECRET=$(key)
SECRETS_MASTER_KEY=$(key)
PII_ENC_KEY=$(key)
PII_HMAC_KEY=$(key)
CLINICAL_ENC_KEY=$(key)
TOTP_ENC_KEY=$(key)
LOG_HMAC_KEY=$(key)
RESEARCH_HMAC_KEY=$(key)
ML_WORKER_TOKEN=$(head -c24 /dev/urandom | base64 | tr -d '/+=')
KNOWLEDGE_DB_PASSWORD=$(head -c24 /dev/urandom | base64 | tr -d '/+=')
MAIL_FROM=noreply@kapel.1gb.ru
FILE_SCANNER=none
ML_MODELS_DIR=$PWD/ml-models
GIGACHAT_AUTH_KEY=
EOF
echo ".env создан (600). Впишите GIGACHAT_AUTH_KEY и положите модели в $PWD/ml-models"

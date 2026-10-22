#!/usr/bin/env bash
# Поднимает демо для показа: свежая синтетическая база, сервер на :3000, насыщенные данные.
# Использование: bash scripts/demo-up.sh   (остановка: Ctrl+C). Данные — в data/demo-show/ (в Git не попадают).
set -euo pipefail
cd "$(dirname "$0")/.."
D="$PWD/data/demo-show"
rm -rf "$D" && mkdir -p "$D"
key() { head -c32 /dev/urandom | base64; }
export NODE_ENV=development PORT="${PORT:-3000}" DATA_MODE=synthetic DEMO_MODE=1 AI_DEMO_REPLIES=1
export DB_PATH="$D/tdr.sqlite3" DATA_DIR="$D" PUBLIC_BASE_URL="http://127.0.0.1:$PORT" BASE_URL="http://127.0.0.1:$PORT"
export SESSION_SECRET="$(key)" SECRETS_MASTER_KEY="$(key)" PII_ENC_KEY="$(key)" PII_HMAC_KEY="$(key)" CLINICAL_ENC_KEY="$(key)"
export TOTP_ENC_KEY="$(key)" LOG_HMAC_KEY="$(key)" RESEARCH_HMAC_KEY="$(key)"
export SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_SECURE=0 MAIL_FROM=noreply@cc.example.test FILE_SCANNER=none
# Ключ GigaChat из .env (если задан) включает настоящую модель на синтетических данных; без него работает заглушка.
# Приложение .env само не читает, поэтому ключ и сертификат НУЦ Минцифры передаются окружением.
GIGA_KEY="$(grep -E '^GIGACHAT_AUTH_KEY=.+' .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
if [ -n "$GIGA_KEY" ]; then
  export GIGACHAT_AUTH_KEY="$GIGA_KEY" NODE_EXTRA_CA_CERTS="$PWD/deploy/certs/russian_trusted_root_ca.pem"
fi
node scripts/migrate.js && node scripts/seed-demo.js
node src/server.js &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
for _ in $(seq 40); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.5; done
node scripts/seed-demo-rich.js
node scripts/seed-demo-bulk.js
node scripts/seed-demo-journey.js
node scripts/seed-demo-analytics.js
node scripts/seed-demo-flower.js
echo "Готово: http://127.0.0.1:$PORT — кнопки «Войти как» на главной. Остановка: Ctrl+C"
wait $SERVER

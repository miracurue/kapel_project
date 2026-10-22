# Сертификаты для исходящих вызовов

`russian_trusted_root_ca.pem` — корневой сертификат НУЦ Минцифры («Russian Trusted Root CA», действует до 2032-02-27).
Публичный, не секрет. Без него Node не проверяет цепочку серверов GigaChat (`ngw.devices.sberbank.ru`, `api.giga.chat`):
ошибки `SELF_SIGNED_CERT_IN_CHAIN` / `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.

- Источник: https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
- SHA-256: `D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`
- Подключается только процессу приложения переменной `NODE_EXTRA_CA_CERTS` (в compose — `/app/certs/russian_trusted_root_ca.pem`;
  `scripts/demo-up.sh` ставит её сам, когда в `.env` есть `GIGACHAT_AUTH_KEY`). В системное хранилище доверия не добавляется.

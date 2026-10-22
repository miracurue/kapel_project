#!/usr/bin/env bash
set -euo pipefail

npm run format:check
npm run lint
npm run licenses
npm run openapi
npm run texts
npm run secrets
npm audit --audit-level=high
npm run test:gate -- --upto В3 --kind all

npm run test:regression

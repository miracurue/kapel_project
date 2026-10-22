#!/usr/bin/env bash
set -euo pipefail

tag="${1:?usage: scripts/deploy-demo.sh <git-tag>}"
host="${DEMO_SSH_HOST:?set DEMO_SSH_HOST}"
remote_dir="${DEMO_REMOTE_DIR:-/opt/clinical-compass}"
case "$tag" in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo "tag must look like v0.1.0" >&2; exit 2;; esac
git rev-parse --verify "refs/tags/$tag" >/dev/null
archive="$(mktemp --suffix=.tar.gz)"
trap 'rm -f "$archive"' EXIT
git archive --format=tar.gz --output="$archive" "$tag"
scp "$archive" "$host:/tmp/clinical-compass-$tag.tar.gz"
ssh "$host" "set -e; mkdir -p '$remote_dir/releases/$tag'; tar -xzf '/tmp/clinical-compass-$tag.tar.gz' -C '$remote_dir/releases/$tag'; cd '$remote_dir/releases/$tag'; docker compose -f deploy/compose.demo.yml build; docker compose -f deploy/compose.demo.yml run --rm app node scripts/migrate.js; docker compose -f deploy/compose.demo.yml up -d"

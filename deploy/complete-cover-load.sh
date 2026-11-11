#!/usr/bin/env bash
set -euo pipefail
umask 077

root=/opt/fast-search-qdrant
state=/var/lib/fast-search-qdrant
collection=$1
shift
[[ "$collection" =~ ^isbn_covers_[0-9a-f]{16}$ ]]
report="$state/$collection.json"

# Give transient image download failures two additional passes without retrying saved books.
for pass in 1 2 3; do
  /usr/bin/bash "$root/deploy/run-cover-loader.sh" "$@" &
  loader=$!
  trap 'kill -TERM "$loader" 2>/dev/null || true; wait "$loader" || true; exit 143' TERM INT
  status=0
  wait "$loader" || status=$?
  trap - TERM INT
  if [[ "$status" -eq 0 ]]; then break; fi
  if [[ "$status" -ne 2 || "$pass" -eq 3 ]]; then exit "$status"; fi
  sleep 30
done

exec /usr/bin/node --env-file=/etc/fast-search-isbn.env --env-file=/etc/fast-search-qdrant.env \
  "$root/scripts/verify-cover-load.mjs" --report "$report" \
  --queries "$root/data/cover-search/phase-4-validation/queries.json" \
  --master /opt/fast-search-isbn/current/public/master.json \
  --editions /var/lib/fast-search-isbn/amazon-editions.json \
  --snapshot --stage-env /etc/fast-search-isbn.env

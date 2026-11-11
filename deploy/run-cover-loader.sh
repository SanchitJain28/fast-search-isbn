#!/usr/bin/env bash
set -euo pipefail
umask 077

root=/opt/fast-search-qdrant
state=/var/lib/fast-search-qdrant
exec flock --nonblock --no-fork "$state/loader.lock" /usr/bin/node \
  --env-file=/etc/fast-search-isbn.env --env-file=/etc/fast-search-qdrant.env \
  "$root/scripts/load-cover-vectors.mjs" \
  --input "$root/data/cover-search/phase-4-input" \
  --seed "$root/data/cover-search/phase-1/covers.jsonl" \
  --master /opt/fast-search-isbn/current/public/master.json \
  --editions /var/lib/fast-search-isbn/amazon-editions.json \
  --python "$root/python/bin/python" --state "$state" "$@"

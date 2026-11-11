#!/usr/bin/env bash
set -euo pipefail
umask 077

name=isbn-cover-qdrant
env_file=/etc/fast-search-qdrant.env
image=qdrant/qdrant:v1.17.0

if ! docker container inspect "$name" >/dev/null 2>&1; then
  if ss -H -ltn '( sport = :6335 or sport = :6334 )' | grep -q .; then
    echo "Qdrant's private ports are already in use." >&2
    exit 1
  fi
  if [[ ! -e "$env_file" ]]; then
    admin_key="$(openssl rand -hex 32)"
    read_key="$(openssl rand -hex 32)"
    {
      printf 'QDRANT__SERVICE__API_KEY=%s\n' "$admin_key"
      printf 'QDRANT__SERVICE__READ_ONLY_API_KEY=%s\n' "$read_key"
      printf 'QDRANT__SERVICE__HOST=127.0.0.1\nQDRANT__SERVICE__HTTP_PORT=6335\n'
    } > "$env_file"
    unset admin_key read_key
  fi
  chmod 600 "$env_file"
  docker run -d --name "$name" --restart unless-stopped --network host --cpus 2 --memory 4g \
    --env-file "$env_file" -v "$name:/qdrant/storage" "$image" >/dev/null
else
  docker start "$name" >/dev/null
fi

for attempt in {1..30}; do
  if curl -fsS --max-time 2 http://127.0.0.1:6335/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS --max-time 2 http://127.0.0.1:6335/healthz >/dev/null
listeners="$(ss -H -ltn '( sport = :6335 or sport = :6334 )' | awk '{print $4}')"
if ! grep -qx '127.0.0.1:6335' <<< "$listeners" || grep -Evq '^127\.0\.0\.1:633[45]$' <<< "$listeners"; then
  docker stop "$name" >/dev/null
  echo 'Qdrant did not bind exclusively to loopback.' >&2
  exit 1
fi

node --env-file="$env_file" --input-type=module - <<'JS'
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:6335';
const collections = await fetch(base + '/collections');
assert([401, 403].includes(collections.status), 'Qdrant accepted an unauthenticated request.');
const headers = { 'api-key': process.env.QDRANT__SERVICE__READ_ONLY_API_KEY, 'content-type': 'application/json' };
const read = await fetch(base + '/collections', { headers });
assert.equal(read.status, 200);
const write = await fetch(base + '/collections/__phase4_readonly_test', {
  method: 'PUT', headers, body: JSON.stringify({ vectors: { size: 1536, distance: 'Cosine' } }),
});
assert([401, 403].includes(write.status), 'Qdrant accepted a write with the read-only key.');
console.log('Qdrant is healthy on loopback and enforces read-only access.');
JS

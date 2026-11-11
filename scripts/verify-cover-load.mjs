import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createCoverEmbedder } from '../server/cover-match/embedding.js';
import { createQdrantCoverClient } from '../server/cover-match/qdrant.js';

async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function snapshotAndRestore({ collection, state, url, writeKey, count, qdrant }) {
  async function request(endpoint, options = {}) {
    const response = await fetch(new URL(endpoint, url), {
      ...options, headers: { 'api-key': writeKey, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(900000),
    });
    if (!response.ok) throw new Error(`Qdrant snapshot operation returned HTTP ${response.status}.`);
    return response;
  }
  const endpoint = `/collections/${collection}/snapshots`;
  const { result } = await (await request(`${endpoint}?wait=true`, { method: 'POST' })).json();
  assert.match(result.name, /^[\w.-]+\.snapshot$/);
  const snapshots = path.join(state, 'snapshots');
  await mkdir(snapshots, { recursive: true, mode: 0o700 });
  const file = path.join(snapshots, result.name);
  const response = await request(`${endpoint}/${result.name}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${file}.partial`, { mode: 0o600 }));
  const sha256 = await checksum(`${file}.partial`);
  if (result.checksum) assert.equal(sha256, result.checksum, 'Downloaded snapshot checksum does not match.');
  await rename(`${file}.partial`, file);
  const restore = `${collection}_restore_${Date.now()}`;
  const restored = await request(`/collections/${restore}/snapshots/recover?wait=true`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ location: `file:///qdrant/snapshots/${collection}/${result.name}`, priority: 'snapshot', checksum: sha256 }),
  });
  assert.equal((await restored.json()).result, true);
  assert.equal(await qdrant.count(restore), count, 'Restored snapshot count does not match.');
  return { file, sha256, restoredCollection: restore, restoredCount: count };
}

async function stageScannerSettings(file, state, collection, url, readKey) {
  const content = await readFile(file, 'utf8');
  assert(!/^\s*(?:export\s+)?COVER_VECTOR_SEARCH_ENABLED\s*=\s*["']?true\b/m.test(content),
    'Turn off the live vector setting before staging another collection.');
  assert.match(readKey, /^[a-f0-9]{64}$/);
  const settings = {
    COVER_VECTOR_SEARCH_ENABLED: 'false', QDRANT_URL: url.origin,
    COVER_VECTOR_COLLECTION: collection, QDRANT_API_KEY: readKey,
  };
  const rest = content.split('\n').filter(line => !Object.hasOwn(settings, line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=/)?.[1])).join('\n');
  const next = rest.trimEnd() + '\n\n' + Object.entries(settings).map(([key, value]) => `${key}=${value}\n`).join('');
  const permissions = await stat(file);
  const backup = path.join(state, `scanner-env-${Date.now()}.bak`);
  await copyFile(file, backup);
  await chmod(backup, 0o600);
  const temp = await mkdtemp(path.join(path.dirname(file), '.cover-settings-'));
  try {
    const staged = path.join(temp, 'environment');
    await writeFile(staged, next, { mode: permissions.mode & 0o777 });
    await chown(staged, permissions.uid, permissions.gid);
    assert.equal(await readFile(file, 'utf8'), content, 'The scanner settings changed while staging the collection.');
    await rename(staged, file);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return { settingsFile: file, enabled: false, backup };
}

async function main() {
  const { values } = parseArgs({ options: {
    report: { type: 'string' }, queries: { type: 'string' }, master: { type: 'string' }, editions: { type: 'string' },
    snapshot: { type: 'boolean' }, sample: { type: 'boolean' }, 'stage-env': { type: 'string' },
  } });
  assert(values.report && values.queries && values.master && values.editions, 'Pass report, queries, master and editions paths.');
  assert(!values['stage-env'] || (!values.sample && values.snapshot), 'Staging requires a full verified load and snapshot.');
  const readKey = process.env.QDRANT__SERVICE__READ_ONLY_API_KEY;
  const writeKey = process.env.QDRANT__SERVICE__API_KEY;
  const apiKey = process.env.GEMINI_API_KEY;
  const url = new URL(process.env.QDRANT_URL || 'http://127.0.0.1:6335');
  assert(readKey && apiKey && (!values.snapshot || writeKey) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    'Use a private Qdrant address with the required keys.');
  const load = JSON.parse(await readFile(values.report, 'utf8'));
  const { collection } = load;
  assert.match(collection, /^isbn_covers_[0-9a-f]{16}$/);
  assert(values.sample || load.complete, 'The full cover load has not finished.');
  assert(load.finished === load.selected && load.counts.saved > 0 && !load.counts.retry && !load.counts.pending,
    'Cover load has unfinished or retryable records.');
  async function verifyInputs() {
    for (const name of ['master', 'editions']) {
      assert.equal(await checksum(values[name]), load.inputs[name].sha256, `The ${name} changed during the load.`);
    }
  }
  await verifyInputs();
  const qdrant = createQdrantCoverClient({ url, apiKey: readKey });
  await qdrant.ensureCollection(collection);
  assert.equal(await qdrant.count(collection), load.counts.saved);
  const queries = JSON.parse(await readFile(values.queries, 'utf8'));
  const embed = createCoverEmbedder({ apiKey });
  const probes = [];
  for (const query of queries) {
    const bytes = await readFile(path.join(path.dirname(values.queries), query.image));
    const { vector } = await embed({ bytes, mimeType: 'image/jpeg' }, { signal: AbortSignal.timeout(25000) });
    const hits = (await qdrant.search(collection, vector)).slice(0, 3);
    if (query.expectedIsbn) {
      assert(hits.some(hit => hit.isbn === query.expectedIsbn && (hit.amazonIsbn ?? null) === (query.amazonIsbn ?? null)),
        `Expected ISBN ${query.expectedIsbn} or its edition is missing from the shortlist.`);
    }
    probes.push({ label: query.label, expectedIsbn: query.expectedIsbn ?? null, hits });
  }
  const state = path.dirname(values.report);
  const snapshot = values.snapshot && await snapshotAndRestore({ collection, state, url, writeKey, count: load.counts.saved, qdrant });
  await verifyInputs();
  const settings = values['stage-env'] && await stageScannerSettings(values['stage-env'], state, collection, url, readKey);
  const result = { collection, sample: Boolean(values.sample), count: load.counts.saved, probes, snapshot, settings };
  const output = path.join(state, `${collection}-${values.sample ? 'sample-' : ''}verified.json`);
  await writeFile(`${output}.tmp`, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  await rename(`${output}.tmp`, output);
  console.log(JSON.stringify(result));
}

main().catch(error => {
  console.error(error.name === 'ApiError' ? `Gemini verification returned HTTP ${error.status}.` : error.message);
  process.exitCode = 1;
});

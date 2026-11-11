import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackingStore } from '../server/store.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const candidate = path.join(root, 'data/amazon-metadata/master-with-authors.json');
const source = fs.existsSync(candidate) ? candidate : path.join(root, 'public/master.json');
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'isbn-cover-pilot-'));
try {
  for (const name of ['src', 'server', 'package.json', 'index.html', 'vite.config.js']) {
    fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(stage, 'node_modules'), 'junction');
  fs.mkdirSync(path.join(stage, 'public'));
  const catalogPath = path.join(stage, 'public/master.json');
  fs.copyFileSync(source, catalogPath);
  const databasePath = path.join(stage, 'data/packing.sqlite');
  const editionSource = path.join(root, 'data/amazon-editions.json');
  const editions = fs.existsSync(editionSource) ? JSON.parse(fs.readFileSync(editionSource, 'utf8')) : undefined;
  const store = new PackingStore(databasePath, JSON.parse(fs.readFileSync(catalogPath, 'utf8')), editions);
  try { store.initializeEmpty(); } finally { store.close(); }
  if (editions) fs.copyFileSync(editionSource, path.join(stage, 'data/amazon-editions.json'));

  const vite = path.join(root, 'node_modules/vite/bin/vite.js');
  const build = spawnSync(process.execPath, [vite, 'build'], { cwd: stage, stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error('Could not build the Cover Match pilot.');
  console.log('Disposable Cover Match pilot: http://localhost:3105/?tab=cover');
  const server = spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', '--port', '3105', '--strictPort'], {
    cwd: stage, stdio: 'inherit', env: {
      ...process.env, COVER_MATCH_ENABLED: 'true', SHEETS_SYNC_ENABLED: 'false', PACKING_DB: databasePath, PUBLIC_ORIGIN: '',
    },
  });
  const stop = () => server.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.exitCode = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('close', (code, signal) => resolve(code ?? (['SIGINT', 'SIGTERM'].includes(signal) ? 0 : 1)));
  });
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

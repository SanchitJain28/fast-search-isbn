import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createProductionServer } from './http.js';
const root = fileURLToPath(new URL('../', import.meta.url));
if (fs.existsSync(path.join(root, '.env.local'))) process.loadEnvFile(path.join(root, '.env.local'));
const server = createProductionServer(root);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`Packing server listening on ${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { CatalogTitleMatcher } from './matcher.js';

const catalog = JSON.parse(readFileSync(workerData.catalogPath, 'utf8'));
const catalogVersion = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
if (workerData.expectedCatalogVersion && workerData.expectedCatalogVersion !== catalogVersion) {
  throw new Error('Cover matcher catalog does not match the packing catalog');
}
const matcher = new CatalogTitleMatcher(catalog);
parentPort.postMessage({ catalogVersion });
parentPort.on('message', ({ id, input, options }) => {
  try {
    parentPort.postMessage({ id, result: matcher.match(input, options) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});

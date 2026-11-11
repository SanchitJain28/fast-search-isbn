import test from 'node:test';
import assert from 'node:assert/strict';
import { createScanDemoManager, DEMO_ISBNS } from '../src/dev/scanDemoManager.js';

test('local scan demo simulates outcomes and undo without accessing the network or browser storage', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw Error('Demo must not call the server'); });
  const manager = createScanDemoManager();
  const packed = await manager.markPacked(DEMO_ISBNS.pack);
  assert.equal(packed.statusType, 'PACK');
  assert.equal(packed.order, 'ZB343');
  assert.equal((await manager.markPacked(DEMO_ISBNS.pack)).statusType, 'DUPLICATE');
  assert.equal((await manager.markPacked(DEMO_ISBNS.notFound)).statusType, 'NOT_FOUND');
  await manager.voidScan(packed.id);
  assert.equal(manager.scanLog.find(scan => scan.id === packed.id).statusType, 'VOID');
  assert.equal((await manager.markPacked(DEMO_ISBNS.pack)).statusType, 'PACK');
  assert.equal(createScanDemoManager().scanLog.length, 2);
});

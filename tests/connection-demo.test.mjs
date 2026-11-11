import test from 'node:test';
import assert from 'node:assert/strict';

test('connection demo exercises real retry client with isolated transport and preserves request identity', async t => {
  globalThis.localStorage = { getItem: () => null, setItem() { throw Error('No browser storage writes'); } };
  // The app singleton needs initialization; the demo itself receives separate storage.
  globalThis.localStorage.setItem = () => {};
  globalThis.EventSource = class {};
  t.mock.method(globalThis, 'fetch', () => { throw Error('No network allowed'); });
  t.after(() => { delete globalThis.localStorage; delete globalThis.EventSource; });
  const { createConnectionDemo } = await import('../src/dev/connectionDemoManager.js');
  globalThis.localStorage.setItem = () => { throw Error('Demo must not use browser storage'); };
  const demo = createConnectionDemo();
  const { manager, state } = demo;
  await demo.dropFeed();
  assert.equal(manager.connected, true);
  demo.loseReply();
  await manager.markPacked('9789381416044');
  assert.equal(state.attempts.length, 2);
  assert.equal(new Set(state.attempts).size, 1);
  assert.equal(state.saved.size, 1);
  assert.equal(manager.pending, null);
  await demo.goOffline();
  assert.equal(manager.connected, false);
  await assert.rejects(manager.markPacked('9780000000000'), /Result unconfirmed/);
  const id = manager.pending.id;
  assert.equal(state.saved.size, 1);
  await demo.restore();
  const recovered = await manager.retryPending();
  assert.equal(recovered.id, id);
  assert.equal(state.saved.size, 2);
  assert.equal(manager.pending, null);
});

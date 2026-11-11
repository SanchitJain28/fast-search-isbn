import { Worker } from 'node:worker_threads';

export async function openCoverMatcher({ catalogPath, expectedCatalogVersion }) {
  const worker = new Worker(new URL('./worker-entry.js', import.meta.url), {
    workerData: { catalogPath, expectedCatalogVersion },
  });
  const ready = Promise.withResolvers();
  const pending = new Map();
  let nextId = 0;
  let failure;
  const fail = error => {
    failure ??= error;
    ready.reject(failure);
    for (const job of pending.values()) job.reject(failure);
    pending.clear();
  };
  worker.on('message', message => {
    if (message.catalogVersion) {
      ready.resolve(message.catalogVersion);
      return;
    }
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    if (message.error) job.reject(new Error(message.error));
    else job.resolve(message.result);
  });
  worker.on('error', fail);
  worker.on('exit', code => fail(new Error(`Cover matcher worker exited (${code})`)));
  const catalogVersion = await ready.promise;

  return {
    catalogVersion,
    async match(input, options) {
      if (failure) throw failure;
      if (pending.size >= 8) throw new Error('Cover matcher is busy');
      const id = ++nextId;
      const job = Promise.withResolvers();
      pending.set(id, job);
      try { worker.postMessage({ id, input, options }); }
      catch (error) { pending.delete(id); throw error; }
      return job.promise;
    },
    async close() {
      fail(new Error('Cover matcher is closed'));
      await worker.terminate();
    },
  };
}

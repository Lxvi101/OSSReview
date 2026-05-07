import { FixedClock } from '@gcr/core/testing';
import { type DatabaseHandle, openDatabase, runMigrations } from '@gcr/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobQueue } from './queue.js';

describe('JobQueue', () => {
  let handle: DatabaseHandle;
  let queue: JobQueue;
  let clock: FixedClock;

  beforeEach(() => {
    handle = openDatabase({ path: ':memory:' });
    runMigrations(handle);
    clock = new FixedClock('2026-01-01T00:00:00.000Z');
    queue = new JobQueue(handle.kysely, clock);
  });

  afterEach(async () => {
    await handle.destroy();
  });

  it('enqueues then picks the job', async () => {
    const { id, created } = await queue.enqueue({ name: 'demo', data: { hello: 'world' } });
    expect(created).toBe(true);
    const job = await queue.pickOne('worker-1');
    expect(job?.id).toBe(id);
    expect(job?.state).toBe('running');
    expect(job?.data).toEqual({ hello: 'world' });
  });

  it('uniqueKey collapses redundant enqueues', async () => {
    const a = await queue.enqueue({ name: 'demo', data: {}, uniqueKey: 'x' });
    const b = await queue.enqueue({ name: 'demo', data: {}, uniqueKey: 'x' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
  });

  it('respects priority then id ordering', async () => {
    const lo = await queue.enqueue({ name: 'a', data: {}, priority: 0 });
    const hi = await queue.enqueue({ name: 'b', data: {}, priority: 10 });
    const first = await queue.pickOne('w');
    expect(first?.id).toBe(hi.id);
    const second = await queue.pickOne('w');
    expect(second?.id).toBe(lo.id);
  });

  it('respects run_after', async () => {
    const future = new Date('2030-01-01T00:00:00.000Z').toISOString();
    await queue.enqueue({ name: 'demo', data: {}, runAfter: future });
    expect(await queue.pickOne('w')).toBeNull();
  });

  it('retries on failure with exponential backoff until max_attempts', async () => {
    const { id } = await queue.enqueue({ name: 'demo', data: {}, maxAttempts: 3 });
    await queue.pickOne('w');
    let r = await queue.markFailedOrRequeue(id, 'boom');
    expect(r.requeued).toBe(true);
    await queue.pickOne('w'); // Note: in real flow run_after blocks immediate re-pick;
    // this test just exercises the requeue/fail path without actually waiting.
    r = await queue.markFailedOrRequeue(id, 'boom');
    expect(r.requeued).toBe(true);
    r = await queue.markFailedOrRequeue(id, 'boom');
    expect(r.requeued).toBe(false);
    expect((await queue.byId(id))?.state).toBe('failed');
  });

  it('release stale locks: requeues without bumping attempts', async () => {
    const { id } = await queue.enqueue({ name: 'demo', data: {} });
    await queue.pickOne('w');
    // Pretend that was 999h ago by lowering the threshold to 0.
    const released = await queue.releaseStaleLocks(0);
    expect(released).toBe(1);
    const after = await queue.byId(id);
    expect(after?.state).toBe('queued');
    expect(after?.attempts).toBe(0);
  });
});

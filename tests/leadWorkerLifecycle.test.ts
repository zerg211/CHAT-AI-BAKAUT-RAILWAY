import { afterEach, expect, it, vi } from 'vitest';

const claim = vi.hoisted(() => vi.fn());
vi.mock('../src/db/repositories.js', () => ({
  ConversationRepository: class {},
  LeadRepository: class { claimDueLeadOutbox = claim; }
}));
import { startLeadOutboxWorker } from '../src/ai/leadOutbox.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); claim.mockReset(); });

it('Y08 slow-overlapping-ticks: a slow claim does not accumulate concurrent batches', async () => {
  vi.useFakeTimers();
  let release!: (items: never[]) => void;
  claim.mockImplementation(() => new Promise<never[]>(resolve => { release = resolve; }));
  const stop = startLeadOutboxWorker({ intervalMs: 10 });
  try {
    await vi.advanceTimersByTimeAsync(100);
    expect(claim).toHaveBeenCalledTimes(1);
  } finally {
    release([]);
    if (typeof stop === 'function') await stop();
  }
});

it('Y08 close-rebuild: stop drains the accepted batch and prevents later ticks', async () => {
  vi.useFakeTimers();
  let release!: (items: never[]) => void;
  claim.mockImplementationOnce(() => new Promise<never[]>(resolve => { release = resolve; }));
  claim.mockResolvedValue([]);
  const stop = startLeadOutboxWorker({ intervalMs: 10 });
  expect(typeof stop).toBe('function');
  let drained = false;
  const closing = stop().then(() => { drained = true; });
  await vi.advanceTimersByTimeAsync(100);
  expect(drained).toBe(false);
  expect(claim).toHaveBeenCalledTimes(1);
  release([]);
  await closing;
  expect(drained).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  const secondStop = startLeadOutboxWorker({ intervalMs: 10 });
  await vi.advanceTimersByTimeAsync(25);
  await secondStop();
  const count = claim.mock.calls.length;
  await vi.advanceTimersByTimeAsync(100);
  expect(claim).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
});

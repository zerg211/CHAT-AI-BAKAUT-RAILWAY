import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { attachRequestAbortHandler } from '../src/routes/chat.js';

class FakeRequestRaw extends EventEmitter {
  aborted = false;
}

function attach(raw: FakeRequestRaw, controller = new AbortController()) {
  const cleanup = attachRequestAbortHandler({
    raw: {
      get aborted() {
        return raw.aborted;
      },
      once: raw.once.bind(raw),
      off: raw.off.bind(raw)
    }
  }, controller);
  return { controller, cleanup };
}

describe('chat route request abort handling', () => {
  it('does not abort generation on a normal request close event', () => {
    const raw = new FakeRequestRaw();
    const { controller, cleanup } = attach(raw);

    raw.emit('close');

    expect(controller.signal.aborted).toBe(false);
    cleanup();
  });

  it('aborts generation when the request is explicitly aborted', () => {
    const raw = new FakeRequestRaw();
    const { controller, cleanup } = attach(raw);

    raw.emit('aborted');

    expect(controller.signal.aborted).toBe(true);
    cleanup();
  });

  it('aborts on close only when Node marks the request as aborted', () => {
    const raw = new FakeRequestRaw();
    const { controller, cleanup } = attach(raw);

    raw.aborted = true;
    raw.emit('close');

    expect(controller.signal.aborted).toBe(true);
    cleanup();
  });

  it('removes abort listeners after cleanup', () => {
    const raw = new FakeRequestRaw();
    const { controller, cleanup } = attach(raw);

    cleanup();
    raw.emit('aborted');

    expect(controller.signal.aborted).toBe(false);
  });
});

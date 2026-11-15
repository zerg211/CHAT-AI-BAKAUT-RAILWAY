/** A render opportunity for nonempty answer text, not a status or a read receipt. */
export function createAnswerDeliveryMetric(startedAt = performance.now()) {
  let state: 'idle' | 'waiting' | 'measured' | 'disposed' = 'idle';
  let pending: Promise<number | null> | null = null;
  let resolveMeasurement: ((value: number | null) => void) | undefined;
  let frame: number | null = null;
  let generation = 0;
  let reporting: Promise<void> | null = null;
  function cancelFrames() {
    generation++;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }
  function cleanup() {
    cancelFrames();
    document.removeEventListener('visibilitychange', visibilityChanged);
  }
  function schedule() {
    if (state !== 'waiting' || frame !== null || document.visibilityState !== 'visible') return;
    const attempt = ++generation;
    frame = requestAnimationFrame(() => {
      if (attempt !== generation) return;
      frame = null;
      if (state !== 'waiting' || document.visibilityState !== 'visible') return;
      frame = requestAnimationFrame(() => {
        if (attempt !== generation) return;
        frame = null;
        if (state !== 'waiting' || document.visibilityState !== 'visible') return;
        state = 'measured';
        cleanup();
        resolveMeasurement?.(Math.round(performance.now() - startedAt));
        resolveMeasurement = undefined;
      });
    });
  }
  function visibilityChanged() {
    cancelFrames();
    schedule();
  }
  function dispose() {
    state = 'disposed';
    cleanup();
    resolveMeasurement?.(null);
    resolveMeasurement = undefined;
  }
  return {
    dispose,
    observe(text: string) {
      if (state === 'disposed' || state === 'measured' || !text.trim()) return;
      if (state === 'idle') {
        state = 'waiting';
        pending = new Promise(resolve => { resolveMeasurement = resolve; });
        document.addEventListener('visibilitychange', visibilityChanged);
      }
      schedule();
    },
    report(baseUrl: string, sessionId: string, messageId: string | undefined, visitorId: string) {
      if (reporting) return reporting;
      if (!pending || !messageId) { dispose(); return Promise.resolve(); }
      reporting = (async () => {
        try {
          const firstUsefulContentMs = await pending;
          if (state === 'disposed' || firstUsefulContentMs === null || !Number.isSafeInteger(firstUsefulContentMs) || firstUsefulContentMs < 0) return;
          await fetch(`${baseUrl}/api/chat/sessions/${sessionId}/messages/${messageId}/delivery`, {
            method: 'POST', headers: {'Content-Type': 'application/json', 'x-bakaut-visitor-id': visitorId},
            body: JSON.stringify({firstUsefulContentMs}), keepalive: true
          });
        } catch { /* Best-effort telemetry never changes the consultation result. */ }
        finally { dispose(); }
      })();
      return reporting;
    }
  };
}

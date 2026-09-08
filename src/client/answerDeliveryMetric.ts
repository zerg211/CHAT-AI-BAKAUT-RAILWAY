/** A render opportunity for nonempty answer text, not a status or a read receipt. */
export function createAnswerDeliveryMetric(startedAt = performance.now()) {
  let pending: Promise<number | null> | null = null;
  return {
    observe(text: string) {
      if (pending || !text.trim() || document.visibilityState !== 'visible') return;
      pending = new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve(document.visibilityState === 'visible' ? Math.round(performance.now() - startedAt) : null);
      })));
    },
    async report(baseUrl: string, sessionId: string, messageId: string | undefined, visitorId: string) {
      if (!pending || !messageId) return;
      const firstUsefulContentMs = await pending;
      if (firstUsefulContentMs === null || firstUsefulContentMs < 0 || firstUsefulContentMs > 600_000) return;
      try {
        await fetch(`${baseUrl}/api/chat/sessions/${sessionId}/messages/${messageId}/delivery`, {
          method: 'POST', headers: {'Content-Type': 'application/json', 'x-bakaut-visitor-id': visitorId},
          body: JSON.stringify({firstUsefulContentMs}), keepalive: true
        });
      } catch { /* Best-effort telemetry never changes the consultation result. */ }
    }
  };
}

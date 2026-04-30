export type LeadSubmitPayload = {
  sessionId?: string;
  name: string;
  phone?: string;
  email?: string;
  question?: string;
};

type FetchLike = typeof fetch;

export type LeadSubmitOptions = {
  fetcher?: FetchLike;
  timeoutMs?: number;
};

const DEFAULT_LEAD_TIMEOUT_MS = 20_000;
const LEAD_TIMEOUT_MESSAGE = 'Заявка не отправилась вовремя. Попробуйте ещё раз или позвоните в БАКАУТ напрямую.';

export async function submitLead(apiBase: string, payload: LeadSubmitPayload, options: LeadSubmitOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LEAD_TIMEOUT_MS;
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    const response = await Promise.race([
      fetcher(`${apiBase}/api/leads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort(new Error(LEAD_TIMEOUT_MESSAGE));
          reject(new Error(LEAD_TIMEOUT_MESSAGE));
        }, timeoutMs);
      })
    ]);
    if (!response.ok) throw new Error('lead failed');
  } catch (error) {
    if (controller.signal.aborted) throw new Error(LEAD_TIMEOUT_MESSAGE);
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

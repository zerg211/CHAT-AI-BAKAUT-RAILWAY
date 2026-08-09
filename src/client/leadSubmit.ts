export type LeadSubmitPayload = {
  sessionId: string;
  clientLeadId: string;
  name: string;
  phone?: string;
  email?: string;
  question?: string;
};

type FetchLike = typeof fetch;

export type LeadSubmitOptions = {
  visitorId: string;
  fetcher?: FetchLike;
  timeoutMs?: number;
};

export type LeadSubmitReceipt = {
  ok: true;
  status: 'queued';
  outboxId: string;
  lead?: { id?: string };
};

const DEFAULT_LEAD_TIMEOUT_MS = 20_000;
const LEAD_TIMEOUT_MESSAGE = 'Заявка не отправилась вовремя. Попробуйте ещё раз или позвоните в БАКАУТ напрямую.';

export async function submitLead(apiBase: string, payload: LeadSubmitPayload, options: LeadSubmitOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LEAD_TIMEOUT_MS;
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    const response = await Promise.race([
      fetcher(`${apiBase}/api/leads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bakaut-visitor-id': options.visitorId
        },
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
    const body = await response.json().catch(() => null) as Partial<LeadSubmitReceipt> | null;
    if (
      !response.ok ||
      body?.ok !== true ||
      body.status !== 'queued' ||
      typeof body.outboxId !== 'string' ||
      !body.outboxId.trim()
    ) throw new Error('lead failed');
    return body as LeadSubmitReceipt;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(LEAD_TIMEOUT_MESSAGE);
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

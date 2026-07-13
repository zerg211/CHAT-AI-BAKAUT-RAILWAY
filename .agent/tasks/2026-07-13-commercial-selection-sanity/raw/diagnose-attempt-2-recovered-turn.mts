const token = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY;
if (!token) throw new Error('ADMIN_PASSWORD or ADMIN_API_KEY is required');

const baseUrl = 'https://chat-ai-production-3057.up.railway.app';
const sessionId = '710f559f-a5cb-415e-9b43-194ea500afd5';
const turnId = '6350ae91-8b5c-4f6b-ac94-b92a81401816';
const response = await fetch(
  `${baseUrl}/api/admin/conversations/${sessionId}/agent-traces?turnId=${turnId}&limit=500`,
  { headers: { Authorization: `Bearer ${token}` } }
);
if (!response.ok) throw new Error(`Agent trace fetch failed: ${response.status}`);
const payload = await response.json() as { traces: any[] };

console.log(JSON.stringify(payload.traces.map((trace) => ({
  createdAt: trace.createdAt ?? trace.created_at,
  phase: trace.phase,
  eventType: trace.eventType ?? trace.event_type,
  payload: trace.payload
})), null, 2));

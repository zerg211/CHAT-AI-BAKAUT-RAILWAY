import Fastify from 'fastify';
import { describe,it,expect,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { registerRequestDiagnostics } from '../src/observability/requestDiagnostics.js';
import { diagnosticEvent, setDiagnosticSink, type DiagnosticEvent } from '../src/observability/diagnostics.js';
import { openSseReply, closeSseReply } from '../src/routes/sse.js';

describe('request diagnostic lifecycle',()=>{
  it('captures pre-handler rejection and preserves generated ID through raw SSE',async()=>{
    const logs:DiagnosticEvent[]=[];setDiagnosticSink(e=>logs.push(e));const stdout=vi.spyOn(console,'info').mockImplementation(()=>{});
    const app=Fastify({logger:false,genReqId:()=>randomUUID()});registerRequestDiagnostics(app);
    app.get('/api/rejected',async(_req,reply)=>reply.code(429).send({error:'private detail'}));
    app.get('/api/stream',async(req,reply)=>{
      const send=openSseReply(reply,{'x-request-id':req.id,'access-control-expose-headers':'x-request-id, x-chat-turn-id'});
      diagnosticEvent('before_delivery');send('done',{answer:'DO NOT LOG CUSTOMER CONTENT'});closeSseReply(reply);
    });
    try {
      const rejected=await app.inject('/api/rejected');const streamed=await app.inject('/api/stream');
      expect(rejected.statusCode).toBe(429);expect(streamed.headers['x-request-id']).toBeTruthy();
      expect(streamed.headers['access-control-expose-headers']).toContain('x-request-id');
      const trace=logs.filter(e=>e.requestId===streamed.headers['x-request-id']);
      expect(trace.map(e=>e.name)).toContain('request.started');expect(trace.map(e=>e.name)).toContain('delivery.sse.write_attempt');
      expect(logs.find(e=>e.name==='request.rejected')).toMatchObject({statusCode:429});
      expect(JSON.stringify(logs)).not.toContain('DO NOT LOG');expect(JSON.stringify(logs)).not.toContain('private detail');
    } finally {await app.close();setDiagnosticSink(undefined);stdout.mockRestore();}
  });
});

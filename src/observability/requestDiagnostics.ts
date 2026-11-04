import type { FastifyInstance } from 'fastify';
import { performance } from 'node:perf_hooks';
import { bindDiagnosticCallback, diagnosticCompleteness, diagnosticError, diagnosticEvent, runWithDiagnostics } from './diagnostics.js';

export function registerRequestDiagnostics(app: FastifyInstance) {
  app.addHook('onRequest',(request,reply,done) => {
    runWithDiagnostics({requestId:request.id},() => {
      const started = performance.now();
      reply.header('x-request-id',request.id);
      diagnosticEvent('request.started',{method:request.method,route:request.routeOptions.url});
      reply.raw.once('finish',bindDiagnosticCallback(() => diagnosticEvent('delivery.socket.finish',{statusCode:reply.raw.statusCode,basis:'server_socket_finish'})));
      reply.raw.once('close',bindDiagnosticCallback(() => diagnosticEvent('delivery.socket.close',{writableEnded:reply.raw.writableEnded,destroyed:reply.raw.destroyed,durationMs:performance.now()-started,basis:'server_socket_close'})));
      reply.raw.once('error',bindDiagnosticCallback(error => diagnosticError('delivery.socket.error',error)));
      done();
    });
  });
  app.addHook('onError',async (_request,_reply,error) => { diagnosticError('request.failed',error); });
  app.addHook('onResponse',async (request,reply) => {
    diagnosticEvent(reply.statusCode >= 400 ? 'request.rejected' : 'request.complete',{
      method:request.method,route:request.routeOptions.url,statusCode:reply.statusCode,
      basis:'http_response_only',...diagnosticCompleteness()});
  });
}

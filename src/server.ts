import { diagnosticError, diagnosticEvent } from './observability/diagnostics.js';
import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp();

const shutdown = async (signal: string) => {
  diagnosticEvent('service.shutdown.requested',{reason:signal});
  try {
    await app.close();
    app.log.info('Server closed');
    process.exit(0);
  } catch (error) {
    diagnosticError('service.shutdown.failed',error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (error) {
  diagnosticError('service.listen.failed',error);
  process.exit(1);
}

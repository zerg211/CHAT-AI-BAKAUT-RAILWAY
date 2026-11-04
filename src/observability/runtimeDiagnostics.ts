import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { diagnosticEvent, runWithDiagnostics } from './diagnostics.js';

export function startRuntimeDiagnostics() {
  const lag=monitorEventLoopDelay({resolution:20});lag.enable();
  let cpu=process.cpuUsage();
  const timer=setInterval(()=>{
    const memory=process.memoryUsage();const nextCpu=process.cpuUsage();
    runWithDiagnostics({jobId:randomUUID(),jobType:'runtime_health'},()=>diagnosticEvent('service.runtime',{
      rssBytes:memory.rss,heapUsedBytes:memory.heapUsed,heapTotalBytes:memory.heapTotal,
      uptimeMs:process.uptime()*1000,eventLoopLagP95Ms:lag.percentile(95)/1e6,
      cpuUserMs:(nextCpu.user-cpu.user)/1000,cpuSystemMs:(nextCpu.system-cpu.system)/1000
    }));
    cpu=nextCpu;lag.reset();
  },60_000).unref();
  return async()=>{clearInterval(timer);lag.disable();diagnosticEvent('service.stopped');};
}

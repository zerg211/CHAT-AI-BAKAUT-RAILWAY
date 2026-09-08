import {AsyncLocalStorage} from 'node:async_hooks';
import type {ConversationRepository} from '../db/repositories.js';
import {safeError} from './responseUtils.js';

export interface AgentManagerStageEvent {phase:string;eventType:string}
export type AgentManagerStageEmitter=(event:AgentManagerStageEvent)=>void|Promise<void>;
const activeStageEmitter=new AsyncLocalStorage<AgentManagerStageEmitter|undefined>();

export function runWithTurnStageEmitter<T>(emitter:AgentManagerStageEmitter|undefined,operation:()=>T):T {
  return activeStageEmitter.run(emitter,operation);
}

/** Persist public stage identity, deliver the stage, then retain internal evidence. */
export async function recordTurnTelemetry(conversations:ConversationRepository,sessionId:string,turnId:string,
  phase:string,eventType:string,payload:Record<string,unknown>) {
  const eventRepository=conversations as ConversationRepository & {appendTurnEvent?:ConversationRepository['appendTurnEvent']};
  if(typeof eventRepository.appendTurnEvent==='function') {
    await eventRepository.appendTurnEvent.call(conversations,{sessionId,turnId,stage:phase,eventType,payload:{}})
      .catch(error=>console.warn('Agent manager durable event write failed',safeError(error)));
  }
  try {await activeStageEmitter.getStore()?.({phase,eventType});}
  catch(error){console.warn('Agent manager stage delivery failed',safeError(error));}
  await conversations.addAgentTrace({sessionId,turnId,phase,eventType,payload,redacted:true})
    .catch(error=>console.warn('Agent manager trace write failed',safeError(error)));
}

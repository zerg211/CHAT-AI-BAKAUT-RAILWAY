import type {ConversationRepository} from '../db/repositories.js';
import type {ChatResponsePayload,ConversationSession} from '../shared/types.js';
import {DEFAULT_AGENT_MANAGER_TURN_LIMITS} from './agentManagerTurnBudget.js';

export class TurnExecutionInProgressError extends Error {
  readonly code='turn_execution_in_progress';
  constructor(){super('turn_execution_in_progress');this.name='TurnExecutionInProgressError';}
}
export class RecoveryAttemptUnavailableError extends Error {
  readonly code='recovery_attempt_unavailable';
  constructor(){super('recovery_attempt_unavailable');this.name='RecoveryAttemptUnavailableError';}
}
export const MAX_TURN_RECOVERY_ATTEMPTS=2;
export const RECOVERY_LEASE_WAIT_LIMIT_MS=DEFAULT_AGENT_MANAGER_TURN_LIMITS.maxWallTimeMs;
const RECOVERY_LEASE_RETRY_INTERVAL_MS=500;

async function waitForRecoveryLeaseRetry(signal?:AbortSignal){
  if(signal?.aborted)throw new DOMException('The operation was aborted.','AbortError');
  await new Promise<void>((resolve,reject)=>{
    const onTimeout=()=>{signal?.removeEventListener('abort',onAbort);resolve();};
    const timeout=setTimeout(onTimeout,RECOVERY_LEASE_RETRY_INTERVAL_MS);
    const onAbort=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',onAbort);reject(new DOMException('The operation was aborted.','AbortError'));};
    signal?.addEventListener('abort',onAbort,{once:true});timeout.unref?.();
  });
}

/** One recovery claim; contention waits for the same durable turn, never replays an action. */
export async function coordinateTurnRecovery(input:{
  sessionId:string;turnId:string;signal?:AbortSignal;
  conversations:Pick<ConversationRepository,'getSession'> & Partial<Pick<ConversationRepository,'beginRecoveryAttempt'>>;
  completed:(session:ConversationSession)=>Promise<ChatResponsePayload|null>;
  execute:(session:ConversationSession)=>Promise<ChatResponsePayload>;
}):Promise<ChatResponsePayload>{
  const initialSession=await input.conversations.getSession(input.sessionId);
  if(!initialSession||initialSession.status!=='active')throw new Error('Conversation session is not active');
  const completed=await input.completed(initialSession);if(completed)return completed;
  if(typeof input.conversations.beginRecoveryAttempt==='function'){
    const claimed=await input.conversations.beginRecoveryAttempt({sessionId:input.sessionId,turnId:input.turnId,maxAttempts:MAX_TURN_RECOVERY_ATTEMPTS});
    if(!claimed)throw new RecoveryAttemptUnavailableError();
  }
  const startedAt=Date.now();
  while(true){
    const session=await input.conversations.getSession(input.sessionId);
    if(!session||session.status!=='active')throw new Error('Conversation session is not active');
    try{return await input.execute(session);}
    catch(error){
      if(!(error instanceof TurnExecutionInProgressError))throw error;
      if(Date.now()-startedAt>=RECOVERY_LEASE_WAIT_LIMIT_MS)throw error;
      await waitForRecoveryLeaseRetry(input.signal);
    }
  }
}

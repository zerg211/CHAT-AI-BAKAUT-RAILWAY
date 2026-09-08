import {describe,it,expect} from 'vitest';
import {buildDialogueQualityAudit,type QualityAuditTurn} from '../src/ai/dialogueQualityAudit.js';
const now=new Date('2026-09-07T12:00:00Z');
const row=(id:string,overrides:Partial<QualityAuditTurn>={}):QualityAuditTurn=>({turnId:id,sessionId:'session',status:'completed',
  createdAt:'2026-09-07T11:00:00Z',deadlineAt:'2026-09-07T11:03:00Z',hasAnswer:true,errorCode:null,errorClass:null,
  buildCommit:null,wallTimeMs:40000,modelCalls:4,recovered:false,rating:null,tools:[],reviewIssues:[],...overrides});
describe('automatic execution audit review queue',()=>{
  it('groups repeat causes without hiding missing answers or judging silent failures as good',()=>{
    const report=buildDialogueQualityAudit([row('one',{hasAnswer:false,status:'failed',wallTimeMs:null,errorCode:'generation_failed'}),
      row('two',{reviewIssues:['missing_source:product-a','missing_source:product-b']}),
      row('three',{reviewIssues:['missing_source:product-c']}),row('four',{createdAt:'2026-09-07T11:30:00Z',resolutionStatus:'resolved',estimatedCostUsd:1})],{hours:24,limit:4,now});
    expect(report.qualityVerdict).toBe('NOT_PROVEN');
    expect(report.possiblyTruncated).toBe(true);
    expect(report.reviewQueue.find(g=>g.reason==='review:missing_source')?.count).toBe(2);
    expect(report.reviewQueue.find(g=>g.reason==='expired_without_answer')?.count).toBe(1);
    expect(report.turns[3].customerQuality).toBe('NOT_JUDGED');
    expect(report.latency.sampleCount).toBe(3);
    expect(report.cost.resolvedConversationCount).toBe(1);
  });
  it('reports cost per latest resolved conversation without treating unknown rows as zero-cost proof',()=>{
    const report=buildDialogueQualityAudit([
      row('resolved',{estimatedCostUsd:'1.25' as never,totalTokens:'100' as never,resolutionStatus:'resolved',wallTimeMs:'42000' as never}),
      row('unresolved',{sessionId:'second',estimatedCostUsd:0.75,resolutionStatus:'unresolved'}),
      row('unknown',{sessionId:'third',estimatedCostUsd:null,resolutionStatus:'unknown'})
    ],{hours:24,limit:500,now});

    expect(report.cost).toMatchObject({
      conversationCount:3,
      resolvedConversationCount:1,
      unresolvedConversationCount:1,
      unknownConversationCount:1,
      totalEstimatedCostUsd:2,
      costPerResolvedConversationUsd:2
    });
    expect(report.turns[0]).toMatchObject({ estimatedCostUsd: 1.25, totalTokens: 100, wallTimeMs: 42000 });
  });
  it('does not label an in-flight turn as an expired failure or expose raw error messages',()=>{
    const report=buildDialogueQualityAudit([row('active',{hasAnswer:false,deadlineAt:'2026-09-07T12:01:00Z'}),
      row('bad',{errorClass:'private buyer text +7999'})],{hours:24,limit:500,now});
    expect(report.turns[0].signals).toEqual([]);
    expect(report.turns[1].signals).toEqual(['failure_class:unclassified']);
    expect(JSON.stringify(report)).not.toContain('private buyer');
  });
});

import {createHash} from 'node:crypto';
import type {Snapshot} from './actions/sqlite';
import type {LiveRecordStore} from './actions/ai-live-store';
import type {Env,Item,Verdict} from './types';
import {classify} from './classifier';
import {readAnalysis} from './post-analysis';
import {notify,alertTitle,alertMessage} from './pushover';
import {candidateFromSnapshot,prioritizeCandidates} from './shadow-context';
import {shadowInput,within,type ShadowCandidate,type ShadowMetrics} from './ai-shadow';
import {classifyLive,LIVE_PROMPT_VERSION,type LiveResult} from './ai-live-classifier';
import {formatLiveNotification,isCriticalMachine,planLiveNotification} from './ai-live-policy';
import {readLiveQueue,writeLiveQueue,type LiveQueueEntry} from './ai-live-queue';

export const LIVE_LIMITS={runMs:180000,requestMs:45000,concurrency:3} as const;
export interface LiveSummary {status:string;attempted:number;classified:number;fallback:number;pending:number;model:string;reasoning:string}
export interface LiveOptions {
 enabled:boolean;model:string;reasoning:string;apiKey:string;store:LiveRecordStore;fetcher?:typeof fetch;
 enrich?:(candidate:ShadowCandidate,signal:AbortSignal)=>Promise<ShadowCandidate>;
 report?:(summary:LiveSummary)=>void;runMs?:number;requestMs?:number;concurrency?:number;
}
export function liveConfig(env:Record<string,string|undefined>) {
 const model=env.T_MEWS_AI_MODEL?.trim()||'gpt-6.1-sol';
 return {enabled:env.T_MEWS_AI_LIVE==='true',model,reasoning:env.T_MEWS_AI_REASONING?.trim()||(model==='gpt-6-luna'?'none':'medium'),apiKey:env.OPENAI_API_KEY??''};
}
/** Shared for normal-state and per-post GitHub PUTs on the same branch. */
export function serialWriter() {
 let tail:Promise<unknown>=Promise.resolve();
 return <T>(work:()=>Promise<T>):Promise<T>=>{const result=tail.then(work);tail=result.catch(()=>{});return result;};
}
const safeError=(error:unknown)=>{
 const code=error instanceof Error?error.message:'';
 return /^(missing_key|invalid_model|invalid_reasoning|unauthorized|quota_or_rate_limit|upstream_error|model_or_request_error|http_error|bad_json|refused|incomplete|timeout|network_error)$/.test(code)?code:'network_error';
};

/** Close only enrolled work on rollback; ordinary pending rule alerts still use their original keys. */
export async function disableLiveQueue(env:Env,now:number) {
 const queue=await readLiveQueue(env.DB);if(!queue.length)return;
 await env.DB.batch([writeLiveQueue(env.DB,[]),env.DB.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)')
  .bind(`ai-live-disabled:${now}`,'ai_live_disabled',now,JSON.stringify({ids:queue.map(e=>e.id),reason:'disabled'}))]);
}

export async function runLiveQueue(env:Env,snapshot:()=>Snapshot,checkpoint:()=>Promise<void>,options:LiveOptions,now:number,startedWall:number,deadline:number,notifyFetch:typeof fetch):Promise<LiveSummary> {
 const summary:LiveSummary={status:'complete',attempted:0,classified:0,fallback:0,pending:0,model:options.model,reasoning:options.reasoning};
 const queue=await readLiveQueue(env.DB);
 if(!queue.length)return {...summary,status:'no_new_posts'};
 const runController=new AbortController(),runTimer=setTimeout(()=>runController.abort(),Math.max(0,deadline-Date.now()));
 const runSignal=runController.signal;
 const exclusive=serialWriter();
 const clockMs=()=>now*1000+Date.now()-startedWall;
 const requestMs=options.requestMs??LIVE_LIMITS.requestMs;
 const initial=snapshot();
 const candidates=new Map(queue.map(entry=>[entry.id,candidateFromSnapshot(initial,entry.id,true)]));
 const order=prioritizeCandidates([...candidates.values()].filter((c):c is ShadowCandidate=>!!c));
 // Material allowance changes and confirmed reports precede ordinary discussion; preserve FIFO otherwise.
 const priority=(c:ShadowCandidate)=>['RESET_ANNOUNCED','BANKED_RESET','LIMIT_CHANGE'].includes(c.rule.classification)?0
  :/\b(?:resets?|banked|usage|limits?|allowances?|quotas?|pro|plans?)\b|🍄/i.test(c.text+' '+c.related.map(r=>r.text??'').join(' '))?1
  :c.kind==='post'?2:c.related.some(r=>r.text)?3:4;
 order.sort((a,b)=>priority(a)-priority(b)||(a.discoveredAt??0)-(b.discoveredAt??0));
 const entries=[...order.map(c=>queue.find(e=>e.id===c.id)!),...queue.filter(e=>!candidates.get(e.id))];
 const setFallback=async(entry:LiveQueueEntry,code:string)=>exclusive(async()=>{
  const latest=await readLiveQueue(env.DB);const current=latest.find(e=>e.id===entry.id);
  if(current&&!current.fallback){current.fallback={code,at:Math.floor(clockMs()/1000)};await writeLiveQueue(env.DB,latest).run();await checkpoint();}
  entry.fallback=current?.fallback??entry.fallback;
 });
 const remove=async(id:string)=>{await writeLiveQueue(env.DB,(await readLiveQueue(env.DB)).filter(e=>e.id!==id)).run();await checkpoint();};
 const process=async(entry:LiveQueueEntry)=>{
  const row=initial.tables.posts.find(p=>p.id===entry.id);
  if(!row)return; // Retained for inspection; never silently discard an unresolved queue reference.
  const analysis=await readAnalysis(env.DB,entry.id);
  const machine:Verdict=analysis.verdict??classify(row.text,analysis.related);
  const post:Item={id:row.id,xStatusId:row.x_status_id,url:row.canonical_url,fingerprint:row.fingerprint,text:row.text,publishedAt:row.published_at,source:row.source,kind:row.kind,related:analysis.related};
  // A prior run may have stopped before its urgent send, even while today's RSS is unavailable.
  if(isCriticalMachine(machine))await exclusive(async()=>{
   runSignal.throwIfAborted();
   await notify(env,`post:${entry.id}`,'alert',alertTitle(machine),alertMessage(post,machine.classification,row.detection_latency_seconds,
    '🛠機械: '+machine.classification+'\n🤖AI: 判定待ち（機械速報）\n',machine),Math.floor(clockMs()/1000),notifyFetch,post,machine.display==='announcement'?machine.classification:undefined);
   await checkpoint();
  });
  let candidate=candidates.get(entry.id);
  let record:Record<string,any>|undefined;
  const deliver=async(result:LiveResult|undefined,error?:string)=>exclusive(async()=>{
   runSignal.throwIfAborted();
   const prior=await env.DB.prepare('SELECT * FROM notifications WHERE id=?').bind(`post:${entry.id}`).first<any>();
   const early=!!prior&&isCriticalMachine(machine);
   const plan=planLiveNotification(machine,result,early,error);
   let delivery:Record<string,any>={kind:'none',mismatch:false};
   if(plan){
    const message=formatLiveNotification(post,machine,result,plan,row.detection_latency_seconds,error);
    const id=early?`ai-diff:${entry.id}`:`post:${entry.id}`;
    delivery={...plan,...message,id};
    await notify(env,id,plan.kind==='diagnostic'?'ai-diagnostic':'alert',message.title,message.message,Math.floor(clockMs()/1000),notifyFetch,post,undefined,
     {priority:plan.priority,updatePost:!early,clock:()=>Math.floor(clockMs()/1000)});
   }
   await checkpoint();
   const receipts=(await env.DB.prepare('SELECT * FROM notifications WHERE id IN (?,?) ORDER BY id').bind(`post:${entry.id}`,`ai-diff:${entry.id}`).all<any>()).results;
   delivery.receipts=receipts;
   const sent=receipts.filter(n=>n.sent_at!==null).map(n=>n.sent_at*1000);
   if(sent.length){delivery.detectedToFirstSendMs=Math.max(0,Math.min(...sent)-row.detected_at*1000);delivery.detectedToLastSendMs=Math.max(0,Math.max(...sent)-row.detected_at*1000);if(row.published_at!==null)delivery.publishedToFirstSendMs=Math.max(0,Math.min(...sent)-row.published_at*1000);}
   return delivery;
  });
  try {record=await options.store.load(entry.id,runSignal);}catch {
   if(runSignal.aborted)return;
   await setFallback(entry,'ledger_unavailable');summary.fallback++;
   await deliver(undefined,'ledger_unavailable');return;
  }
  if(record?.status==='complete'){await exclusive(()=>remove(entry.id));return;}
  if(!record){
   record={version:1,id:entry.id,status:'claimed',createdAt:now,updatedAt:now,model:options.model,reasoning:options.reasoning,promptVersion:LIVE_PROMPT_VERSION,
    machine:structuredClone(machine),candidate:candidate??null,queuedAt:entry.queuedAt};
   try {await options.store.save(entry.id,structuredClone(record),runSignal);}catch {
    if(runSignal.aborted)return;
    await setFallback(entry,'ledger_unavailable');summary.fallback++;await deliver(undefined,'ledger_unavailable');return;
   }
   if(!entry.fallback&&candidate){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),requestMs);
    const signal=AbortSignal.any([runSignal,controller.signal]);
    const started=clockMs();
    let apiRequests=0;
    try {
     if(options.enrich)candidate=await within(signal,()=>options.enrich!(candidate!,signal));
     record.input=shadowInput(candidate);record.inputHash=createHash('sha256').update(JSON.stringify(record.input)).digest('hex');
     record.requestPreparedAt=clockMs();
     await options.store.save(entry.id,structuredClone(record),signal);
     signal.throwIfAborted();
     const fetcher=(async(input:any,init:any)=>{apiRequests++;summary.attempted++;record!.apiStartedAt=clockMs();return (options.fetcher??fetch)(input,init);}) as typeof fetch;
     record.result=await classifyLive(candidate,{...options,fetcher,observe:(m:ShadowMetrics)=>Object.assign(record!,m)},signal);
     summary.classified++;
    }catch(error){record.error=signal.aborted?'timeout':safeError(error);}
    finally{clearTimeout(timer);record.apiRequests=apiRequests;record.apiCompletedAt=clockMs();record.elapsedMs=record.apiCompletedAt-started;}
   }else record.error=entry.fallback?.code??'result_unavailable';
   record.status='decided';record.decidedAt=clockMs();record.detectedToDecisionMs=Math.max(0,record.decidedAt-row.detected_at*1000);
  }else if(record.status==='claimed'){
   // A prior process may have paid for an unrecorded response; never send it again automatically.
   record.error=entry.fallback?.code??'interrupted';record.status='decided';record.decidedAt=clockMs();
  }
  if(entry.fallback){delete record.result;record.error=entry.fallback.code;}
  record.updatedAt=Math.floor(clockMs()/1000);
  try {await options.store.save(entry.id,structuredClone(record),runSignal);}catch {summary.status='record_checkpoint_pending';return;}
  if(!record.result)summary.fallback++;
  const delivery=await deliver(record.result,record.error);
  record.delivery=delivery;record.status='complete';record.updatedAt=Math.floor(clockMs()/1000);
  try {await options.store.save(entry.id,structuredClone(record),runSignal);}catch {summary.status='record_checkpoint_pending';return;}
  await exclusive(()=>remove(entry.id));
 };
 let index=0;
 const worker=async()=>{
  // Leave enough time to persist and deliver the last request before the 5-minute Actions limit.
  while(index<entries.length&&!runSignal.aborted&&Date.now()+requestMs+20000<deadline){
   const entry=entries[index++];
   try {await process(entry);}catch {summary.status='checkpoint_pending';}
  }
 };
 try {await Promise.all(Array.from({length:Math.max(1,Math.min(3,options.concurrency??LIVE_LIMITS.concurrency))},worker));}
 finally {clearTimeout(runTimer);runController.abort();}
 summary.pending=(await readLiveQueue(env.DB)).length;
 if(summary.pending&&summary.status==='complete')summary.status='queued';
 return summary;
}

import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {GitHubStateStore} from '../src/actions/store';
import {GitHubLiveStore} from '../src/actions/ai-live-store';
import {LocalD1} from '../src/actions/sqlite';
import {candidateFromSnapshot} from '../src/shadow-context';
import {enrichLiveContext} from '../src/ai-live-context';
import {classifyLive,LIVE_PROMPT_VERSION,type LiveResult} from '../src/ai-live-classifier';
import {liveConfig} from '../src/ai-live';
import {shadowInput} from '../src/ai-shadow';
import {formatLiveNotification,planLiveNotification} from '../src/ai-live-policy';
import {notify} from '../src/pushover';
import type {Env,Item,Verdict} from '../src/types';

// Owner-authorized fixed dry runs and two synthetic transport/display probes.
// Re-running this workflow never resets the old test key or reuses real post notification IDs.
const fixture=JSON.parse(readFileSync(new URL('../tests/fixtures/ai-live-verification.json',import.meta.url),'utf8'));
const started=Date.now(),evaluationDeadline=started+150000;
const repository=process.env.GITHUB_REPOSITORY??'',token=process.env.GITHUB_TOKEN??'';
const config=liveConfig(process.env);
const records=new GitHubLiveStore(repository,token),state=new GitHubStateStore(repository,token);
try {
 if(config.model!=='gpt-6.1-sol'||config.reasoning!=='medium')throw Error('verification_model_mismatch');
 const original=await state.load();if(!original)throw Error('state_missing');
 const results:{id:string,status:string,category?:string,usage?:unknown,referenceCostUsd?:number}[]=[];
 for(const example of fixture.cases){
  const id='probe:live-20261108-'+example.key;
  let record=await records.load(id);
  if(record?.status==='complete'){results.push({id,status:record.error?'failed':'classified',category:record.result?.category,usage:record.usage,referenceCostUsd:record.referenceCostUsd});continue;}
  if(!record){
   if(Date.now()+60000>evaluationDeadline){results.push({id,status:'unstarted_time_budget'});continue;}
   let candidate=candidateFromSnapshot(original,example.postId,true);if(!candidate)throw Error('verification_source_unavailable');
   record={version:1,id,status:'claimed',createdAt:Math.floor(Date.now()/1000),model:config.model,reasoning:config.reasoning,promptVersion:LIVE_PROMPT_VERSION,postId:example.postId,evaluationRole:example.role,notificationAllowed:false};
   await records.save(id,record);
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000),began=Date.now();
   try {
    candidate=await enrichLiveContext(candidate,fetch,controller.signal);
    record.input=shadowInput(candidate);record.inputHash=createHash('sha256').update(JSON.stringify(record.input)).digest('hex');record.machine=candidate.rule;
    await records.save(id,record,controller.signal);
    record.result=await classifyLive(candidate,{...config,observe:metrics=>Object.assign(record!,metrics)},controller.signal);
   }catch(error){record.error=controller.signal.aborted?'timeout':error instanceof Error&&/^(missing_key|invalid_model|invalid_reasoning|unauthorized|quota_or_rate_limit|upstream_error|model_or_request_error|http_error|bad_json|refused|incomplete|timeout|network_error)$/.test(error.message)?error.message:'verification_error';}
   finally{clearTimeout(timer);record.elapsedMs=Date.now()-began;}
   record.status='decided';await records.save(id,record);
  }else if(record.status==='claimed'){record.error='interrupted';record.status='decided';await records.save(id,record);}
  record.status='complete';record.updatedAt=Math.floor(Date.now()/1000);await records.save(id,record);
  results.push({id,status:record.error?'failed':'classified',category:record.result?.category,usage:record.usage,referenceCostUsd:record.referenceCostUsd});
 }
 console.log(JSON.stringify({dryRun:results}));
 if(results.some(r=>r.status!=='classified'))process.exitCode=1;

 const db=new LocalD1(original);
 const env:Env={DB:db.asD1(),MONITOR_ENABLED:'true',SOURCES_JSON:'[]',PUSHOVER_USER_KEY:process.env.PUSHOVER_USER_KEY,PUSHOVER_APP_TOKEN:process.env.PUSHOVER_APP_TOKEN};
 const save=()=>state.save(db.snapshot());
 const safeFetch=(async(input:any,init:any)=>{await save();return fetch(input,{...init,signal:AbortSignal.timeout(8000)});}) as typeof fetch;
 try {
  for(const kind of fixture.notificationProbes){
   if(!['diagnostic','ai-only'].includes(kind))throw Error('invalid_probe');
   const id='probe:live-20261108-display-'+kind,notificationId='ai-live-probe:20261108:'+kind;
   let record=await records.load(id);
   if(record?.status==='complete'){console.log(JSON.stringify({probe:kind,alreadyComplete:true,status:record.delivery?.status}));if(record.delivery?.status!=='sent')process.exitCode=1;continue;}
   const machine:Verdict=kind==='diagnostic'?{classification:'CANDIDATE',notify:true,display:'advisory',reason:'synthetic display probe'}:{classification:'IRRELEVANT',notify:false,reason:'synthetic display probe'};
   const result:LiveResult={category:kind==='diagnostic'?'chatter':'announcement',rationale:'表示形式と配送の制御試験です。実際のTibo投稿の判定ではありません。',confidence:1,uncertainty:''};
   const post:Item={id,xStatusId:null,url:null,fingerprint:id,text:'AI本番通知の表示確認。新しい配布・利用枠変更の速報ではありません。',publishedAt:null,source:'controlled-verification',kind:'post'};
   const plan=planLiveNotification(machine,result,false)!;
   const display=formatLiveNotification(post,machine,result,plan,null);
   const title='[表示試験] '+display.title,message='これは承認済みの表示・配送試験です。新しい配布速報ではありません。\n'+display.message;
   if(!record){record={version:1,id,status:'decided',createdAt:Math.floor(Date.now()/1000),synthetic:true,apiRequests:0,machine,result,delivery:{...plan,title,message,notificationId}};await records.save(id,record);}
   await notify(env,notificationId,'ai-live-probe',title,message,Math.floor(Date.now()/1000),safeFetch,post,undefined,{priority:plan.priority,updatePost:false,clock:()=>Math.floor(Date.now()/1000)});
   await save();
   const receipt=await db.prepare('SELECT * FROM notifications WHERE id=?').bind(notificationId).first<any>();
   record.delivery={...record.delivery,...receipt};record.status='complete';record.updatedAt=Math.floor(Date.now()/1000);await records.save(id,record);
   console.log(JSON.stringify({probe:kind,status:receipt?.status,priority:plan.priority}));
   if(receipt?.status!=='sent')process.exitCode=1;
  }
 }finally {await save();db.close();}
}catch {console.error('Production AI verification stopped; inspect durable per-post records and notification receipts. No secrets or raw upstream bodies are logged.');process.exitCode=1;}

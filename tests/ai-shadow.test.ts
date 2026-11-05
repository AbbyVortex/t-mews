import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyShadow,runShadow,shadowConfig,shadowCandidates,shadowInput,responseMetrics,SHADOW_LIMITS,SHADOW_INSTRUCTIONS,SHADOW_PROMPT_VERSION,validateShadowState,
 type ShadowCandidate,type ShadowResult,type ShadowState,type ShadowOptions,type LegacyShadowState} from '../src/ai-shadow';
import {GitHubShadowStore} from '../src/actions/ai-shadow-store';
import {LocalD1} from '../src/actions/sqlite';

const now=Date.parse('2026-10-30T00:00:00Z')/1000;
const candidate=(id='x:1'):ShadowCandidate=>({id,url:'https://x.com/thsottiaux/status/1',text:'Soon 👀',
 related:[{relation:'reply',author:'someone',text:'Can we get a Codex reset?'}],rule:{classification:'CANDIDATE',notify:true,display:'advisory'}});
const answer=(category:ShadowResult['category']='attention'):ShadowResult=>({category,rationale:'Resetの話題への返信',confidence:0.8,uncertainty:'時刻は未確定'});
const response=(value:unknown=answer())=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const legacy=(count:number,at=now-86400):LegacyShadowState=>({version:1,records:Array.from({length:count},(_,i)=>({id:`legacy:${i}`,attemptedAt:at,status:'classified',model:'gpt-6-luna',result:answer()}))});
function harness(fetcher:typeof fetch=async()=>response()) {
 let saved:ShadowState|undefined;const writes:ShadowState[]=[];
 const options:ShadowOptions={enabled:true,apiKey:'fake-api-key',model:'gpt-6.1-sol',reasoning:'medium',fetcher,
  store:{load:async()=>structuredClone(saved),save:async state=>{saved=structuredClone(state);writes.push(structuredClone(state));}}};
 return {options,writes,get saved(){return saved;},set saved(state:ShadowState|undefined){saved=state;}};
}

test('OFF is explicit and model/key are supplied only through configuration',()=>{
 assert.deepEqual(shadowConfig({}),{enabled:false,model:'gpt-6.1-sol',reasoning:'medium',apiKey:''});
 for(const value of ['TRUE','1','yes','false',''])assert.equal(shadowConfig({T_MEWS_AI_SHADOW:value}).enabled,false);
 assert.deepEqual(shadowConfig({T_MEWS_AI_SHADOW:'true',T_MEWS_AI_MODEL:'another-model',OPENAI_API_KEY:'fixture'}),
  {enabled:true,model:'another-model',reasoning:'medium',apiKey:'fixture'});
 assert.equal(shadowConfig({T_MEWS_AI_MODEL:'gpt-6-luna'}).reasoning,'none');
 assert.equal(shadowConfig({T_MEWS_AI_MODEL:'gpt-6-luna',T_MEWS_AI_REASONING:'low'}).reasoning,'low');
});

test('Responses sends minimal separated evidence, strict schema, capped output and no tools or rule bias',async()=>{
 for(const category of ['announcement','attention','unrelated'] as const){
  const result=await classifyShadow(candidate(),{apiKey:'fake-api-key',model:'configured-model',fetcher:async(input,init)=>{
   assert.equal(input,'https://api.openai.com/v1/responses');assert.equal(init?.redirect,'error');
   assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer fake-api-key');
   const body=JSON.parse(init?.body as string);assert.equal(body.model,'configured-model');assert.equal(body.store,false);
   assert.equal(body.reasoning.effort,'medium');assert.equal(body.max_output_tokens,4096);assert.equal(body.service_tier,'default');
   assert.equal(body.tools,undefined);assert.equal(body.previous_response_id,undefined);
   assert.deepEqual(JSON.parse(body.input),shadowInput(candidate()));
   assert.equal(body.text.format.strict,true);assert.equal(body.text.format.type,'json_schema');
   assert.deepEqual(body.text.format.schema.properties.category.enum,['announcement','attention','unrelated']);
   assert.ok(!body.input.includes('fake-api-key'));assert.ok(!body.input.includes('CANDIDATE'));
   return response(answer(category));
  }},new AbortController().signal);
  assert.deepEqual(result,answer(category));
 }
 assert.match(SHADOW_INSTRUCTIONS,/Favor attention/);assert.match(SHADOW_INSTRUCTIONS,/not instructions/);
 assert.match(SHADOW_INSTRUCTIONS,/Do not invent a parent/);
});

test('Sol rejects unsupported reasoning before any storage or API access; Luna accepts none',async()=>{
 const h=harness();let reads=0;h.options.store.load=async()=>{reads++;return undefined;};
 assert.equal((await runShadow([candidate()],{...h.options,reasoning:'none'},now)).status,'invalid_reasoning');
 assert.equal(reads,0);assert.equal(h.writes.length,0);
 assert.equal((await runShadow([candidate()],{...h.options,model:'gpt-6-luna',reasoning:'none'},now)).classified,1);
});

test('new candidate input caps body/context without changing the conventional snapshot',()=>{
 const db=new LocalD1(),before=db.snapshot();db.close();
 const after=structuredClone(before);const p=candidate();
 after.tables.posts.push({id:p.id,text:'x'.repeat(8000),baseline:0,kind:'reply',canonical_url:p.url,classification:'CANDIDATE',detected_at:now,published_at:now});
 after.tables.events.push({id:`analysis:${p.id}`,event_type:'post_analysis',details:JSON.stringify({related:Array.from({length:4},()=>({relation:'reply',text:'y'.repeat(1000)}))})});
 const original=structuredClone(after),[selected]=shadowCandidates(before,after);
 assert.equal(selected.text.length,4000);assert.equal(selected.related.length,2);assert.equal(selected.related[0].text?.length,500);
 assert.deepEqual(after,original);
 const input=shadowInput({...p,text:'a'.repeat(5000),recentContext:Array.from({length:5},(_,i)=>({id:`x:${i}`,url:null,text:'z'.repeat(800),publishedAt:now-i,author:'thsottiaux',source:'saved-history'}))});
 assert.equal(input.text.length,4000);assert.equal(input.recentContext.length,4);assert.ok(input.recentContext.every(c=>c.text.length===700));
});

test('durable claim precedes a call; failed/result-unknown posts never retry across restarts',async()=>{
 let calls=0;const h=harness(async()=>{calls++;const record=h.saved?.records.at(-1);assert.equal(record?.status,'claimed');assert.deepEqual(record?.input,shadowInput(candidate()));assert.match(record!.inputHash,/^[a-f0-9]{64}$/);throw new Error('fake-api-key raw upstream failure');});
 await runShadow([candidate()],h.options,now);
 assert.equal(h.saved?.records[0].error,'network_error');assert.equal(h.saved?.records[0].status,'failed');
 assert.ok(!JSON.stringify(h.saved).includes('fake-api-key'));
 await runShadow([candidate()],h.options,now+300);assert.equal(calls,1);
 h.saved!.records[0].status='claimed';
 await runShadow([candidate()],h.options,now+600);assert.equal(calls,1);
});

test('authentication, exhausted credits, rate limits, model rejection and upstream errors are compact failures',async()=>{
 for(const [http,error] of [[401,'unauthorized'],[403,'unauthorized'],[429,'quota_or_rate_limit'],[500,'upstream_error'],[503,'upstream_error'],[400,'model_or_request_error'],[404,'model_or_request_error']] as const){
  const h=harness(async()=>new Response('secret raw provider body',{status:http}));
  const result=await runShadow([candidate()],h.options,now);
  assert.equal(result.attempted,1);assert.equal(result.classified,0);assert.equal(h.saved?.records[0].error,error);
  assert.ok(!JSON.stringify(h.saved).includes('secret raw'));
 }
});

test('invalid JSON/schema, incomplete output, refusals and oversized response never become classifications',async()=>{
 const invalid=[()=>new Response('not json'),()=>response({category:'bomb'}),()=>response({...answer(),confidence:2}),
  ()=>response({...answer(),confidence:'0.8'}),()=>response({...answer(),rationale:'x'.repeat(241)}),
  ()=>response({...answer(),extra:true}),()=>Response.json({status:'incomplete',output:[]}),
  ()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]}),
  ()=>new Response('x'.repeat(64001))];
 for(const make of invalid){const h=harness(async()=>make());await runShadow([candidate()],h.options,now);
  assert.equal(h.saved?.records[0].status,'failed');assert.equal(h.saved?.records[0].result,undefined);}
});

test('network and a stalled response body obey the API timeout without retries',async()=>{
 for(const stream of [false,true]){
  const controller=new AbortController();let calls=0;
  const options={model:'gpt-6-luna',apiKey:'fake',fetcher:async()=>{calls++;
   return stream?new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}})):await new Promise<Response>(()=>{});
  }};
  const pending=classifyShadow(candidate(),options,controller.signal);
  setTimeout(()=>controller.abort(),10);
  await assert.rejects(pending,/timeout/);assert.equal(calls,1);
 }
});

test('run-wide deadline stops a stalled shadow store before any paid request',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let calls=0;const h=harness(async()=>{calls++;return response();});
 h.options.store.load=async()=>new Promise(()=>{});
 const running=runShadow([candidate()],h.options,now);
 t.mock.timers.tick(SHADOW_LIMITS.runMs);
 assert.equal((await running).status,'timeout');assert.equal(calls,0);
});

test('request deadline saves failed claim and never replays it',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let called!:()=>void;const started=new Promise<void>(resolve=>called=resolve);
 const h=harness(async()=>{called();return new Promise(()=>{});});
 const running=runShadow([candidate()],h.options,now);
 await started;t.mock.timers.tick(SHADOW_LIMITS.requestMs);
 await running;assert.equal(h.saved?.records[0].error,'timeout');
 assert.equal(h.saved?.records[0].status,'failed');
});

test('per-run, UTC-day and new 20-attempt ceiling include failures and pending survives restarts',async()=>{
 let calls=0;const h=harness(async()=>{calls++;return calls%3===0?new Response('',{status:500}):response();});
 const all=Array.from({length:24},(_,i)=>candidate(`x:${i}`));
 const first=await runShadow(all,h.options,now);assert.equal(first.attempted,2);assert.equal(calls,2);
 assert.equal(h.saved?.pending.length,22);
 h.saved=structuredClone(h.saved);
 for(let run=1;run<10;run++)await runShadow([],h.options,now+run*300);
 assert.equal(calls,10);assert.equal(h.saved?.records.length,10);
 for(let run=0;run<5;run++)await runShadow([],h.options,now+86400+run*300);
 assert.equal(calls,20);assert.equal(h.saved?.records.length,20);assert.equal(h.saved?.pending.length,4);
 assert.ok(h.saved!.records.some(r=>r.status==='failed'));
 assert.equal((await runShadow(all,h.options,now+2*86400)).status,'trial_complete');assert.equal(calls,20);
});

test('legacy 40 records remain unchanged and are never paid again; cumulative 100 is shared with v2',async()=>{
 let calls=0;const h=harness(async()=>{calls++;return response();});
 const old=legacy(40),copy=structuredClone(old);h.options.store.loadLegacy=async()=>old;
 await runShadow([...old.records.map(r=>candidate(r.id)),candidate()],h.options,now);
 assert.equal(calls,1);assert.deepEqual(old,copy);assert.deepEqual(h.saved?.records.map(r=>r.id),['x:1']);
 const capped=harness(async()=>{calls++;return response();});capped.options.store.loadLegacy=async()=>legacy(99);
 assert.equal((await runShadow([candidate('x:2'),candidate('x:3')],capped.options,now)).attempted,1);
 assert.equal((await runShadow([],capped.options,now+300)).status,'trial_complete');assert.equal(capped.saved?.records.length,1);
});

test('legacy and v2 attempts share the UTC-day ceiling',async()=>{
 let calls=0;const h=harness(async()=>{calls++;return response();});h.options.store.loadLegacy=async()=>legacy(9,now);
 assert.equal((await runShadow([candidate('x:1'),candidate('x:2')],h.options,now)).attempted,1);
 assert.equal((await runShadow([],h.options,now+300)).attempted,0);assert.equal(calls,1);
 assert.equal((await runShadow([],h.options,now+86400)).attempted,1);assert.equal(calls,2);
});

test('eight explicit evaluations count toward the trial and subsequent live daily budget without consuming waiting live posts',async()=>{
 let calls=0;const h=harness(async()=>{calls++;return response();});
 const cases=Array.from({length:8},(_,i)=>({...candidate(`eval:${i}`),postId:`x:${i}`,evaluation:true,contextMode:'context' as const}));
 h.saved={version:2,startedAt:now,records:[],pending:[candidate('waiting')],skipped:[]};
 await runShadow(cases.slice(0,4),{...h.options,evaluation:true},now);
 await runShadow(cases.slice(4),{...h.options,evaluation:true},now+300);
 assert.equal(calls,8);assert.equal(h.saved!.records.filter(r=>r.evaluation).length,8);assert.deepEqual(h.saved!.pending.map(c=>c.id),['waiting']);
 await runShadow(Array.from({length:15},(_,i)=>candidate(`live:${i}`)),h.options,now+600);assert.equal(calls,10);
 for(let run=0;run<5;run++)await runShadow([],h.options,now+86400+run*300);
 assert.equal(calls,20);assert.equal((await runShadow([],h.options,now+2*86400)).status,'trial_complete');
});

test('explicit evaluation can run after the old daily 10 are used while live daily 10 and cumulative 20/100 stay bounded',async()=>{
 for(const oldCount of [40,99]){
  let calls=0;const h=harness(async()=>{calls++;return response();});
  const old=legacy(oldCount);old.records.slice(0,10).forEach(r=>r.attemptedAt=now);
  const oldBefore=structuredClone(old);h.options.store.loadLegacy=async()=>old;
  assert.equal((await runShadow([candidate('waiting-live')],h.options,now)).attempted,0);
  const cases=Array.from({length:24},(_,i)=>({...candidate(`eval:${i}`),postId:`x:${i}`,evaluation:true,contextMode:'context' as const}));
  for(let batch=0;batch<2;batch++)await runShadow(cases.slice(batch*4,batch*4+4),{...h.options,evaluation:true},now+batch*60);
  assert.equal(calls,oldCount===40?8:1,'fixed comparison bypasses only the daily gate, never cumulative 100');
  assert.equal((await runShadow([],h.options,now+180)).attempted,0,'ordinary monitoring still respects the daily ceiling');
  for(let batch=2;batch<6;batch++)await runShadow(cases.slice(batch*4,batch*4+4),{...h.options,evaluation:true},now+batch*60);
  assert.equal(calls,Math.min(20,100-oldCount));
  assert.equal(h.saved!.records.length,calls);assert.ok(h.saved!.records.every(r=>r.evaluation));
  assert.equal((await runShadow([cases[23]],{...h.options,evaluation:true},now+600)).status,'trial_complete');
  assert.equal(h.saved!.pending.some(c=>c.id==='waiting-live'),true);
  assert.deepEqual(old,oldBefore);
 }
});

test('bounded pending queue records displaced IDs and expires stale pending visibly across restart',async()=>{
 const h=harness();h.options.store.loadLegacy=async()=>legacy(10,now);
 await runShadow(Array.from({length:35},(_,i)=>candidate(`queue:${String(i).padStart(2,'0')}`)),h.options,now);
 assert.equal(h.saved?.pending.length,32);assert.equal(h.saved?.skipped.length,3);
 assert.ok(h.saved!.skipped.every(r=>r.reason==='queue_capacity'));
 const snapshot=structuredClone(h.saved);h.saved=snapshot;
 const result=await runShadow([],h.options,now+72*3600+1);
 assert.equal(result.attempted,0);assert.equal(h.saved?.pending.length,0);
 assert.equal(h.saved?.skipped.filter(r=>r.reason==='queue_expired').length,32);
});

test('seven-day trial ends visibly without API calls or resetting its start',async()=>{
 const h=harness();await runShadow([candidate()],h.options,now);const before=structuredClone(h.saved);
 const result=await runShadow([candidate('x:2')],h.options,now+7*86400);
 assert.equal(result.status,'trial_expired');assert.equal(result.attempted,0);assert.deepEqual(h.saved,before);
});

test('completed and incomplete Responses preserve usage; reasoning tokens are not charged twice',async()=>{
 const usage={input_tokens:1000,output_tokens:300,total_tokens:1300,input_tokens_details:{cached_tokens:200},output_tokens_details:{reasoning_tokens:250}};
 const metrics=responseMetrics({model:'gpt-6.1-sol',status:'completed',usage},'gpt-6.1-sol');
 assert.deepEqual(metrics.usage,{input_tokens:1000,output_tokens:300,total_tokens:1300,cached_tokens:200,reasoning_tokens:250});
 assert.equal(metrics.referenceCostUsd,0.00462);
 for(const status of ['completed','incomplete']){
  const h=harness(async()=>Response.json({status,model:'gpt-6.1-sol',usage,output:status==='completed'?[{type:'message',content:[{type:'output_text',text:JSON.stringify(answer())}]}]:[]}));
  await runShadow([candidate()],h.options,now);const record=h.saved!.records[0];
  assert.deepEqual(record.usage,metrics.usage);assert.equal(record.referenceCostUsd,0.00462);
  assert.equal(record.model,'gpt-6.1-sol');assert.equal(record.reasoning,'medium');assert.equal(record.promptVersion,SHADOW_PROMPT_VERSION);
  assert.equal(record.actualModel,'gpt-6.1-sol');assert.equal(record.responseStatus,status);assert.ok(record.elapsedMs!>=0);
  assert.equal(record.status,status==='completed'?'classified':'failed');
  if(status==='incomplete')assert.equal(record.error,'incomplete');
 }
 assert.equal(responseMetrics({usage:{...usage,total_tokens:999}},'gpt-6.1-sol').usage,undefined);
 assert.equal(responseMetrics({usage:{...usage,output_tokens_details:{reasoning_tokens:301}}},'gpt-6.1-sol').usage,undefined);
 assert.equal(responseMetrics({usage},'unknown-model').referenceCostUsd,undefined);
});

test('existing malformed or over-limit shadow state is not silently reset',async()=>{
 const h=harness();h.saved={version:2,records:[]} as unknown as ShadowState;
 assert.equal((await runShadow([candidate()],h.options,now)).status,'shadow_store_error');assert.equal(h.writes.length,0);
 assert.throws(()=>validateShadowState({version:2,startedAt:now,records:Array(21).fill({id:'x',attemptedAt:now,status:'claimed'}),pending:[],skipped:[]}));
});

test('GitHub shadow uses only a separate bounded file, independent CAS, and an already existing branch',async()=>{
 const requests:{url:string;body:any}[]=[];let step=0;
 const h=harness();await runShadow([candidate()],h.options,now);
 const store=new GitHubShadowStore('AbbyVortex/t-mews','github-fixture',async(input,init)=>{
  const url=String(input);requests.push({url,body:init?.body?JSON.parse(init.body as string):null});
  assert.ok(!url.includes('/state.json'));assert.ok(!url.includes('/git/'));assert.equal(init?.redirect,'error');
  if(step++===0)return new Response('',{status:404});
  if(step===2)return Response.json({content:{sha:'first'}});
  assert.equal(requests.at(-1)!.body.sha,'first');return Response.json({content:{sha:'second'}});
 });
 const signal=new AbortController().signal;
 assert.equal(await store.load(signal),undefined);await store.save(h.saved!,signal);await store.save(h.saved!,signal);
 assert.equal(requests[0].url,'https://api.github.com/repos/AbbyVortex/t-mews/contents/ai-shadow-v2.json?ref=monitor-state');
 assert.equal(requests[1].body.branch,'monitor-state');assert.equal(requests[1].body.sha,undefined);
 assert.ok(!Buffer.from(requests[1].body.content,'base64').toString().includes('github-fixture'));
});

test('GitHub shadow restores the saved claim and rejects conflicts without retry or raw errors',async()=>{
 const h=harness();await runShadow([candidate()],h.options,now);
 let calls=0;const store=new GitHubShadowStore('AbbyVortex/t-mews','fixture',async(_input,init)=>{
  calls++;return init?.method==='GET'?Response.json({sha:'old',encoding:'base64',content:Buffer.from(JSON.stringify(h.saved)).toString('base64')}):new Response('private error body',{status:409});
 });
 const signal=new AbortController().signal;assert.deepEqual(await store.load(signal),h.saved);
 await assert.rejects(store.save(h.saved!,signal),/^Error: shadow_save_failed$/);assert.equal(calls,2);
});

test('legacy file remains read-only and its SHA never replaces the v2 CAS token',async()=>{
 const old=legacy(40),oldBytes=JSON.stringify(old),h=harness();await runShadow([candidate()],h.options,now);
 const requests:{url:string;method:string;body:any}[]=[];
 const store=new GitHubShadowStore('AbbyVortex/t-mews','fixture',async(input,init)=>{
  const url=String(input),method=init?.method??'GET',body=init?.body?JSON.parse(init.body as string):undefined;
  requests.push({url,method,body});
  if(url.includes('/ai-shadow.json')){
   assert.equal(method,'GET','old observations are read-only');
   return Response.json({sha:'legacy-sha',encoding:'base64',content:Buffer.from(oldBytes).toString('base64')});
  }
  assert.ok(url.includes('/ai-shadow-v2.json'));
  if(method==='GET')return Response.json({sha:'v2-sha',encoding:'base64',content:Buffer.from(JSON.stringify(h.saved)).toString('base64')});
  assert.equal(body.sha,'v2-sha');assert.equal(body.branch,'monitor-state');return Response.json({content:{sha:'v2-updated'}});
 });
 const signal=new AbortController().signal;
 assert.deepEqual(await store.load(signal),h.saved);assert.deepEqual(await store.loadLegacy(signal),old);
 await store.save(h.saved!,signal);
 assert.equal(requests.filter(r=>r.method==='PUT').length,1);assert.equal(JSON.stringify(old),oldBytes);
});

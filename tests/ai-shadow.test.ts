import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyShadow,runShadow,shadowConfig,shadowCandidates,SHADOW_LIMITS,SHADOW_INSTRUCTIONS,validateShadowState,
 type ShadowCandidate,type ShadowResult,type ShadowState,type ShadowOptions} from '../src/ai-shadow';
import {GitHubShadowStore} from '../src/actions/ai-shadow-store';
import {LocalD1} from '../src/actions/sqlite';

const now=Date.parse('2026-10-30T00:00:00Z')/1000;
const candidate=(id='x:1'):ShadowCandidate=>({id,url:'https://x.com/thsottiaux/status/1',text:'Soon 👀',
 related:[{relation:'reply',author:'someone',text:'Can we get a Codex reset?'}],rule:{classification:'CANDIDATE',notify:true,display:'advisory'}});
const answer=(category:ShadowResult['category']='attention'):ShadowResult=>({category,rationale:'Resetの話題への返信',confidence:0.8,uncertainty:'時刻は未確定'});
const response=(value:unknown=answer())=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
function harness(fetcher:typeof fetch=async()=>response()) {
 let saved:ShadowState|undefined;const writes:ShadowState[]=[];
 const options:ShadowOptions={enabled:true,apiKey:'fake-api-key',model:'gpt-6-luna',fetcher,
  store:{load:async()=>structuredClone(saved),save:async state=>{saved=structuredClone(state);writes.push(structuredClone(state));}}};
 return {options,writes,get saved(){return saved;},set saved(state:ShadowState|undefined){saved=state;}};
}

test('OFF is explicit and model/key are supplied only through configuration',()=>{
 assert.deepEqual(shadowConfig({}),{enabled:false,model:'gpt-6-luna',apiKey:''});
 for(const value of ['TRUE','1','yes','false',''])assert.equal(shadowConfig({T_MEWS_AI_SHADOW:value}).enabled,false);
 assert.deepEqual(shadowConfig({T_MEWS_AI_SHADOW:'true',T_MEWS_AI_MODEL:'another-model',OPENAI_API_KEY:'fixture'}),
  {enabled:true,model:'another-model',apiKey:'fixture'});
});

test('Responses sends minimal separated evidence, strict schema, capped output and no tools or rule bias',async()=>{
 for(const category of ['announcement','attention','unrelated'] as const){
  const result=await classifyShadow(candidate(),{apiKey:'fake-api-key',model:'configured-model',fetcher:async(input,init)=>{
   assert.equal(input,'https://api.openai.com/v1/responses');assert.equal(init?.redirect,'error');
   assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer fake-api-key');
   const body=JSON.parse(init?.body as string);assert.equal(body.model,'configured-model');assert.equal(body.store,false);
   assert.equal(body.reasoning.effort,'none');assert.equal(body.max_output_tokens,768);
   assert.equal(body.tools,undefined);assert.equal(body.previous_response_id,undefined);
   assert.deepEqual(JSON.parse(body.input),{author:'thsottiaux',text:candidate().text,related:candidate().related});
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

test('new candidate input caps body/context without changing the conventional snapshot',()=>{
 const db=new LocalD1(),before=db.snapshot();db.close();
 const after=structuredClone(before);const p=candidate();
 after.tables.posts.push({id:p.id,text:'x'.repeat(8000),baseline:0,kind:'reply',canonical_url:p.url,classification:'CANDIDATE',detected_at:now,published_at:now});
 after.tables.events.push({id:`analysis:${p.id}`,event_type:'post_analysis',details:JSON.stringify({related:Array.from({length:4},()=>({relation:'reply',text:'y'.repeat(1000)}))})});
 const original=structuredClone(after),[selected]=shadowCandidates(before,after);
 assert.equal(selected.text.length,4000);assert.equal(selected.related.length,2);assert.equal(selected.related[0].text?.length,500);
 assert.deepEqual(after,original);
});

test('durable claim precedes a call; failed/result-unknown posts never retry across restarts',async()=>{
 let calls=0;const h=harness(async()=>{calls++;assert.equal(h.saved?.records.at(-1)?.status,'claimed');throw new Error('fake-api-key raw upstream failure');});
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
  ()=>new Response('x'.repeat(32001))];
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

test('per-run, UTC-day and total experiment ceilings include failed claims and keep a bounded dedup ledger',async()=>{
 let calls=0;const h=harness(async()=>{calls++;return response();});
 const all=Array.from({length:110},(_,i)=>candidate(`x:${i}`));
 const first=await runShadow(all,h.options,now);assert.equal(first.attempted,2);assert.equal(calls,2);
 for(let run=0;run<10;run++)await runShadow(all,h.options,now+run*300);
 assert.equal(calls,10);assert.equal(h.saved?.records.length,10);
 for(let day=1;day<10;day++)for(let run=0;run<5;run++)await runShadow(all,h.options,now+day*86400+run*300);
 assert.equal(calls,100);assert.equal(h.saved?.records.length,100);
 await runShadow(all,h.options,now+20*86400);assert.equal(calls,100);
});

test('existing malformed or over-limit shadow state is not silently reset',async()=>{
 const h=harness();h.saved={version:2,records:[]} as unknown as ShadowState;
 assert.equal((await runShadow([candidate()],h.options,now)).status,'shadow_store_error');assert.equal(h.writes.length,0);
 assert.throws(()=>validateShadowState({version:1,records:Array(101).fill({id:'x',attemptedAt:now,status:'claimed'})}));
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
 assert.equal(requests[0].url,'https://api.github.com/repos/AbbyVortex/t-mews/contents/ai-shadow.json?ref=monitor-state');
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

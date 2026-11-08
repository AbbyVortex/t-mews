import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyLive,LIVE_INSTRUCTIONS,LIVE_PROMPT_VERSION,type LiveResult} from '../src/ai-live-classifier';
import {shadowInput,type ShadowCandidate,type ShadowMetrics} from '../src/ai-shadow';

const key='fixture-api-key';
const candidate:ShadowCandidate={id:'x:2117035794678546764',url:'https://x.com/thsottiaux/status/2117035794678546764',text:'Day 28/ Banked 2/2',
 related:[],parentStatus:'not_applicable',rule:{classification:'BANKED_RESET',notify:true,display:'announcement'},
 recentContext:[{id:'x:2116692529970311254',url:'https://x.com/thsottiaux/status/2116692529970311254',text:'Banked 1/2',publishedAt:1793493800,author:'thsottiaux',source:'saved-history'}]};
const answer=(category:LiveResult['category']='announcement'):LiveResult=>({category,rationale:'前日の第一弾に続く第二弾の配布報告。',confidence:.98,uncertainty:''});
const response=(value:unknown=answer(),extra:Record<string,unknown>={})=>Response.json({status:'completed',model:'gpt-6.1-sol',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}],...extra});
const options={model:'gpt-6.1-sol',reasoning:'medium',apiKey:key};
const signal=()=>new AbortController().signal;

test('production Responses contract supports all five meanings with separated bounded evidence and no rule bias',async()=>{
 for(const category of ['announcement','attention','limit_change','chatter','unrelated'] as const){
  const result=await classifyLive(candidate,{...options,fetcher:async(input,init)=>{
   assert.equal(input,'https://api.openai.com/v1/responses');assert.equal(init?.redirect,'error');
   const body=JSON.parse(String(init?.body));
   assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.reasoning.effort,'medium');
   assert.equal(body.store,false);assert.equal(body.max_output_tokens,4096);assert.equal(body.tools,undefined);
   assert.equal(body.text.format.strict,true);assert.equal(body.text.format.type,'json_schema');
   assert.deepEqual(body.text.format.schema.properties.category.enum,['announcement','attention','limit_change','chatter','unrelated']);
   assert.deepEqual(JSON.parse(body.input),shadowInput(candidate));
   assert.ok(!body.input.includes('BANKED_RESET'));assert.ok(!body.input.includes(key));
   return response(answer(category));
  }},signal());
  assert.deepEqual(result,answer(category));
 }
 assert.match(LIVE_PROMPT_VERSION,/live/);
 assert.match(LIVE_INSTRUCTIONS,/notification value/);assert.match(LIVE_INSTRUCTIONS,/Pro\/paid-plan/);
 assert.match(LIVE_INSTRUCTIONS,/untrusted evidence/);assert.match(LIVE_INSTRUCTIONS,/short 👀/);
 assert.match(LIVE_INSTRUCTIONS,/product-design chatter/);assert.match(LIVE_INSTRUCTIONS,/not invent a parent/);
});

test('missing key and invalid model or Sol reasoning never make a request; model stays configurable',async()=>{
 let calls=0;const fetcher:typeof fetch=async()=>{calls++;return response();};
 for(const [override,error] of [[{apiKey:''},'missing_key'],[{model:'bad model'},'invalid_model'],[{reasoning:'none'},'invalid_reasoning']] as const){
  await assert.rejects(classifyLive(candidate,{...options,...override,fetcher},signal()),e=>e instanceof Error&&e.message===error);
 }
 assert.equal(calls,0);
 await classifyLive(candidate,{...options,model:'gpt-6-luna',reasoning:'none',fetcher},signal());
 assert.equal(calls,1);
});

test('HTTP and network failures expose only stable failure codes without retries or raw responses',async()=>{
 for(const [status,error] of [[401,'unauthorized'],[403,'unauthorized'],[429,'quota_or_rate_limit'],[500,'upstream_error'],[503,'upstream_error'],[400,'model_or_request_error'],[404,'model_or_request_error'],[409,'http_error']] as const){
  let calls=0;
  await assert.rejects(classifyLive(candidate,{...options,fetcher:async()=>{calls++;return new Response(key+' provider body',{status});}},signal()),e=>e instanceof Error&&e.message===error);
  assert.equal(calls,1);
 }
 await assert.rejects(classifyLive(candidate,{...options,fetcher:async()=>{throw Error(key+' raw network data');}},signal()),e=>e instanceof Error&&e.message==='network_error');
});

test('schema violations, refusals and oversized bodies cannot become live notification decisions',async()=>{
 for(const make of [()=>new Response('not-json'),()=>response({...answer(),category:'bomb'}),()=>response({...answer(),confidence:1.1}),
  ()=>response({...answer(),confidence:'1'}),()=>response({...answer(),rationale:''}),()=>response({...answer(),rationale:'x'.repeat(241)}),
  ()=>response({...answer(),extra:true}),()=>new Response('x'.repeat(64001)),
  ()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]})]){
  await assert.rejects(classifyLive(candidate,{...options,fetcher:async()=>make()},signal()),e=>e instanceof Error&&['bad_json','refused'].includes(e.message));
 }
});

test('usage survives incomplete/bad output; reasoning is included in output, and result text redacts keys',async()=>{
 const usage={input_tokens:1000,output_tokens:300,total_tokens:1300,input_tokens_details:{cached_tokens:200},output_tokens_details:{reasoning_tokens:250}};
 for(const [value,status] of [[answer(),'incomplete'],[{invalid:true},'completed']] as const){
  let observed:ShadowMetrics|undefined;
  await assert.rejects(classifyLive(candidate,{...options,observe:m=>observed=m,fetcher:async()=>response(value,{status,usage})},signal()));
  assert.deepEqual(observed?.usage,{input_tokens:1000,output_tokens:300,total_tokens:1300,cached_tokens:200,reasoning_tokens:250});
  assert.equal(observed?.referenceCostUsd,.00462);
 }
 const result=await classifyLive(candidate,{...options,fetcher:async()=>response({...answer(),rationale:key,uncertainty:key})},signal());
 assert.ok(!JSON.stringify(result).includes(key));assert.equal(result.rationale,'[redacted]');
});

test('network and stalled response deadlines terminate without waiting for the provider',async()=>{
 for(const bodyStalls of [false,true]){
  const controller=new AbortController();let calls=0;
  const started=Date.now();const work=classifyLive(candidate,{...options,fetcher:async()=>{
   calls++;
   if(!bodyStalls)return new Promise<Response>(()=>{});
   return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}}));
  }},controller.signal);
  setTimeout(()=>controller.abort(),15);
  await assert.rejects(work,e=>e instanceof Error&&e.message==='timeout');
  assert.equal(calls,1);assert.ok(Date.now()-started<500);
 }
 const controller=new AbortController();let finish!:(response:Response)=>void,observed=false;
 const late=classifyLive(candidate,{...options,observe:()=>observed=true,fetcher:async()=>new Promise<Response>(resolve=>finish=resolve)},controller.signal);
 await new Promise(resolve=>setTimeout(resolve,0));controller.abort();
 await assert.rejects(late,e=>e instanceof Error&&e.message==='timeout');
 finish(response());await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(observed,false,'a late provider response cannot mutate the durable failure after the deadline');
});

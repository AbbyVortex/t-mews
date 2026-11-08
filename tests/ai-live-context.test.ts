import test from 'node:test';
import assert from 'node:assert/strict';
import {enrichLiveContext} from '../src/ai-live-context';
import {shadowInput,type ShadowCandidate} from '../src/ai-shadow';

const now=1794117540;
const candidate=():ShadowCandidate=>({id:'x:2119308687676432672',url:'https://x.com/thsottiaux/status/2119308687676432672',text:'👀',kind:'post',publishedAt:now,
 related:[{relation:'quote',id:'x:2119232059537514598',author:'thsottiaux'}],rule:{classification:'IRRELEVANT',notify:false,display:null}});
const api=(id='2119232059537514598',author='thsottiaux',text='We doubled the usage on Pro plans and Business 100',extra:Record<string,unknown>={})=>Response.json({code:200,status:{type:'status',id,text,author:{screen_name:author},created_timestamp:now-1,...extra}});

test('an explicit missing quote is fetched and bounded with identity evidence, without mutating the source',async()=>{
 const input=candidate(),before=structuredClone(input);let calls=0;
 const result=await enrichLiveContext(input,async(url,init)=>{
  calls++;assert.equal(url,'https://api.fxtwitter.com/2/status/2119232059537514598');assert.equal(init?.redirect,'error');
  return api(undefined,undefined,'x'.repeat(700));
 },new AbortController().signal);
 assert.equal(calls,1);assert.equal(result.related[0].text?.length,500);
 assert.equal(result.related[0].source,'fxtwitter-api-v2');assert.equal(result.related[0].publishedAt,now-1);
 assert.equal(result.parentStatus,'not_applicable;quote:x:2119232059537514598=fetched');
 assert.equal(shadowInput(result).parentStatus,result.parentStatus);assert.deepEqual(input,before);
});

test('existing parent/quote text is not fetched, and missing quote IDs never become guessed URLs',async()=>{
 const input={...candidate(),kind:'reply',related:[{relation:'reply' as const,text:'Actual parent'}, {relation:'quote' as const,text:'Existing actual quote'}]};
 const result=await enrichLiveContext(input,async()=>{throw Error('must not fetch');},new AbortController().signal);
 assert.equal(result.parentStatus,'present;quote:unknown=present');assert.deepEqual(result.related,input.related);
 let calls=0;
 const missing={...candidate(),related:[{relation:'quote' as const,url:'https://x.com/person/status/999999'}]};
 const unavailable=await enrichLiveContext(missing,async()=>{calls++;return api();},new AbortController().signal);
 assert.equal(calls,0);assert.match(unavailable.parentStatus!,/quote:unknown=unavailable$/);assert.equal(unavailable.related[0].text,undefined);
});

test('actual parent enrichment runs before quote filling and preserves the parent status',async()=>{
 const input={...candidate(),kind:'reply',related:[{relation:'reply' as const,id:'x:2118161370315448658',author:'person'},...candidate().related]};
 const urls:string[]=[];
 const result=await enrichLiveContext(input,async url=>{urls.push(String(url));return String(url).endsWith('2118161370315448658')?api('2118161370315448658','person','Reset tomorrow?'):api();},new AbortController().signal);
 assert.equal(urls.length,2);assert.equal(result.related[0].relation,'reply');assert.equal(result.related[0].text,'Reset tomorrow?');
 assert.equal(result.related[1].relation,'quote');assert.equal(result.related[1].source,'fxtwitter-api-v2');
 assert.equal(result.parentStatus,'fetched;quote:x:2119232059537514598=fetched');
});

test('quotes with mismatched IDs/authors/future times, missing bodies or invalid responses stay missing',async()=>{
 const cases:[()=>Response,string][]=[
  [()=>api('999999'),'identity_mismatch'],[()=>api(undefined,'different'),'identity_mismatch'],
  [()=>api(undefined,undefined,undefined,{created_timestamp:now+1}),'identity_mismatch'],
  [()=>api(undefined,undefined,''),'unavailable'],[()=>api(undefined,undefined,undefined,{type:'other'}),'unavailable'],
  [()=>Response.json({code:404,status:{}}),'unavailable'],[()=>new Response('private failure',{status:404}),'unavailable'],
  [()=>new Response('invalid-json'),'error'],[()=>new Response('x'.repeat(64001)),'error'],
 ];
 for(const [make,status] of cases){
  const input=candidate();const result=await enrichLiveContext(input,async()=>make(),new AbortController().signal);
  assert.equal(result.parentStatus,'not_applicable;quote:x:2119232059537514598='+status);
  assert.deepEqual(result.related,input.related);assert.ok(!JSON.stringify(result).includes('private failure'));
 }
 const network=await enrichLiveContext(candidate(),async()=>{throw Error('private provider data');},new AbortController().signal);
 assert.match(network.parentStatus!,/=error$/);assert.ok(!JSON.stringify(network).includes('private provider data'));
});

test('only two related references are considered and each eligible quote is read once',async()=>{
 const input={...candidate(),related:['2119232059537514598','2119296267545419987','2119305294291612140'].map(id=>({relation:'quote' as const,id:'x:'+id,author:'@THSOTTIAUX'}))};
 const urls:string[]=[];
 const result=await enrichLiveContext(input,async url=>{urls.push(String(url));return api(String(url).split('/').at(-1));},new AbortController().signal);
 assert.equal(urls.length,2);assert.equal(result.related.length,2);assert.ok(result.related.every(r=>r.text));
 const self=await enrichLiveContext({...candidate(),related:[{relation:'quote',id:candidate().id}]},async()=>{throw Error('must not fetch self');},new AbortController().signal);
 assert.match(self.parentStatus!,/=identity_mismatch$/);
});

test('quote request deadlines and the caller abort stop stalled lookups without a retry',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let called!:(value?:unknown)=>void,calls=0;
 const started=new Promise(resolve=>called=resolve);
 const input={...candidate(),related:[...candidate().related,{relation:'quote' as const,id:'x:2119296267545419987'}]};
 const controller=new AbortController();
 const pending=enrichLiveContext(input,async()=>{calls++;called();return new Promise<Response>(()=>{});},controller.signal);
 await started;controller.abort();
 const result=await pending;assert.equal(calls,1);assert.ok(result.parentStatus?.endsWith('x:2119296267545419987=timeout'));
 assert.ok(result.related.every(reference=>!reference.text));
 let begin!:(value?:unknown)=>void;const first=new Promise(resolve=>begin=resolve);
 const timed=enrichLiveContext(candidate(),async()=>{begin();return new Promise<Response>(()=>{});},new AbortController().signal);
 await first;t.mock.timers.tick(4000);assert.match((await timed).parentStatus!,/=timeout$/);
 let beginOne!:()=>void,beginTwo!:()=>void,requests=0;
 const one=new Promise<void>(resolve=>beginOne=resolve),two=new Promise<void>(resolve=>beginTwo=resolve);
 const both=enrichLiveContext(input,async()=>{requests++;(requests===1?beginOne:beginTwo)();return new Promise<Response>(()=>{});},new AbortController().signal);
 await one;t.mock.timers.tick(4000);await two;t.mock.timers.tick(4000);
 const exhausted=await both;assert.equal(requests,2);
 assert.equal(exhausted.parentStatus,'not_applicable;quote:x:2119232059537514598=timeout,x:2119296267545419987=timeout');
});

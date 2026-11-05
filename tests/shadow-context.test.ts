import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateFromSnapshot,shadowCandidates,prioritizeCandidates,enrichParent} from '../src/shadow-context';
import type {Snapshot} from '../src/actions/sqlite';
import type {ShadowCandidate} from '../src/ai-shadow';

const at=(iso:string)=>Date.parse(iso)/1000;
const now=at('2026-11-01T23:27:20Z');
const post=(id:string,text:string,time=now,extra:Record<string,unknown>={})=>({id:`x:${id}`,canonical_url:`https://x.com/thsottiaux/status/${id}`,
 text,published_at:time,detected_at:time,baseline:0,kind:'post',classification:'IRRELEVANT',...extra});
const snapshot=(posts:Record<string,any>[]=[],events:Record<string,any>[]=[]):Snapshot=>({version:1,tables:{posts,events,state:[],notifications:[],source_health:[]}});
const reply=():ShadowCandidate=>({id:'x:2118376946652557613',url:'https://x.com/thsottiaux/status/2118376946652557613',
 text:'Soon 👀',kind:'reply',publishedAt:now,related:[],recentContext:[],rule:{classification:'IRRELEVANT',notify:false,display:null}});
const api=(id:string,author:string,text:string,extra:Record<string,unknown>={})=>Response.json({code:200,status:{type:'status',id,author:{screen_name:author},text,created_timestamp:now-10,...extra}});

test('Banked 2/2 receives the actual earlier announcement and first grant in chronological order',()=>{
 const forecast=post('2116405414921384099','Day 26/ Next two days will be resets… banked… do with this what you may 👀.',at('2026-10-31T05:42:26Z'));
 const first=post('2116692529970311254','Banked 1/2',at('2026-11-01T00:43:20Z'));
 const last=post('2117035794678546764','Day 28/ Banked 2/2');
 const data=snapshot([last,first,forecast]);const original=structuredClone(data);
 const candidate=candidateFromSnapshot(data,last.id)!;
 assert.deepEqual(candidate.recentContext?.map(p=>p.id),[forecast.id,first.id]);
 assert.deepEqual(candidate.recentContext?.map(p=>p.source),['saved-history','saved-history']);
 assert.equal(candidate.related.length,0);assert.equal(candidate.rule.classification,'IRRELEVANT');
 assert.deepEqual(data,original);
});

test('history excludes future, too-old, other-author and repost evidence, and stays absent for unknown publication time',()=>{
 const target=post('20','Banked 2/2');
 const good=post('10','Banked 1/2',now-72*3600);
 const data=snapshot([target,good,post('11','Banked 9/9',now-72*3600-1),post('12','Banked 3/3',now+1),
  post('13','Banked 5/5',now),post('14','Banked 6/6',now-1,{canonical_url:'https://x.com/other/status/14'}),
  post('15','Banked 7/7',now-2,{kind:'repost'}),post('16','unrelated',now-3)]);
 assert.deepEqual(candidateFromSnapshot(data,target.id)!.recentContext?.map(p=>p.id),[good.id]);
 target.published_at=null as any;assert.deepEqual(candidateFromSnapshot(data,target.id)!.recentContext,[]);
});

test('input bounds favor the same Banked topic over other resets and preserve real related evidence',()=>{
 const data=snapshot([post('90','Banked 2/2 '+'a'.repeat(5000)),
  ...Array.from({length:6},(_,i)=>post(String(20+i),'Banked grant '+String(i)+' '.repeat(5)+'b'.repeat(900),now-100+i)),
  post('80','Reset tomorrow',now-1)], [{id:'analysis:x:90',event_type:'post_analysis',details:JSON.stringify({related:[
   {relation:'quote',xStatusId:'40',url:'https://x.com/person/status/40',author:'person',text:'q'.repeat(900),publishedAt:now-50,provenance:'feed'},
   {relation:'reply',xStatusId:'41',url:'https://x.com/person/status/41',author:'person',text:'r'.repeat(900),provenance:'saved'},
   {relation:'quote',text:'third'},
  ]})}]);
 const c=candidateFromSnapshot(data,'x:90')!;
 assert.equal(c.text.length,4000);assert.equal(c.recentContext?.length,4);
 assert.deepEqual(c.recentContext?.map(p=>p.id),['x:22','x:23','x:24','x:25']);
 assert(c.recentContext?.every(p=>p.text.length===700));
 assert.equal(c.related.length,2);assert.equal(c.related[0].text?.length,500);
 assert.equal(c.related[0].id,'x:40');assert.equal(c.related[1].source,'saved');
});

test('new detection retains baseline/repost exclusions; priority is semantic, original, parent-present, then other replies with FIFO',()=>{
 const before=snapshot([post('10','Existing')]);
 const after=snapshot([...before.tables.posts,post('11','Banked 1/2',now+4),post('12','Original post',now+3),
  post('13','A reply',now+2,{kind:'reply'}),post('14','?!',now+1,{kind:'reply'}),post('15','Another reply',now,{kind:'reply'}),
  post('16','Baseline reset',now,{baseline:1}),post('17','RT reset',now,{kind:'repost'})],
  [{id:'analysis:x:13',event_type:'post_analysis',details:JSON.stringify({related:[{relation:'reply',text:'A known parent',author:'person'}]})}]);
 const selected=shadowCandidates(before,after);
 assert.deepEqual(selected.map(p=>p.id),['x:11','x:12','x:13','x:15','x:14']);
 const copied=structuredClone(selected);prioritizeCandidates(selected);assert.deepEqual(selected,copied);
});

test('parent enrichment performs exactly two fixed-host reads and records bounded verified evidence without mutating candidate',async()=>{
 const c=reply(),original=structuredClone(c),urls:string[]=[];
 const fetched=await enrichParent(c,async(input,init)=>{
  urls.push(String(input));assert.equal(init?.redirect,'error');assert.equal(init?.headers&&'Authorization' in init.headers,false);
  if(urls.length===1)return api('2118376946652557613','thsottiaux',c.text,{replying_to:{screen_name:'person',status:'2118161370315448658'}});
  return api('2118161370315448658','person','Can we get a reset? '+'x'.repeat(700),{replying_to:{status:'99999999'}});
 },new AbortController().signal);
 assert.deepEqual(urls,['https://api.fxtwitter.com/2/status/2118376946652557613','https://api.fxtwitter.com/2/status/2118161370315448658']);
 assert.equal(fetched.parentStatus,'fetched');assert.equal(fetched.related[0].id,'x:2118161370315448658');
 assert.equal(fetched.related[0].source,'fxtwitter-api-v2');assert.equal(fetched.related[0].text?.length,500);
 assert.deepEqual(c,original);
});

test('already-present parents and originals need no fetch; an explicit saved parent ID needs only one read',async()=>{
 const fail:typeof fetch=async()=>{throw new Error('must not fetch');};
 assert.equal((await enrichParent({...reply(),kind:'post'},fail,new AbortController().signal)).parentStatus,'not_applicable');
 assert.equal((await enrichParent({...reply(),related:[{relation:'reply',text:'Actual parent'}]},fail,new AbortController().signal)).parentStatus,'present');
 let calls=0;
 const c={...reply(),related:[{relation:'reply' as const,id:'x:2118161370315448658',author:'person'}]};
 const result=await enrichParent(c,async input=>{calls++;assert.equal(String(input),'https://api.fxtwitter.com/2/status/2118161370315448658');return api('2118161370315448658','person','Reset?');},new AbortController().signal);
 assert.equal(calls,1);assert.equal(result.parentStatus,'fetched');
});

test('missing/private parents, mismatched IDs or authors, invalid shapes and network failures never fabricate evidence',async()=>{
 const cases:[typeof fetch,string][]=[
  [async()=>new Response('',{status:404}),'unavailable'],
  [async()=>api('2118376946652557613','thsottiaux','No parent'),'unavailable'],
  [async()=>api('123456789','thsottiaux','wrong'),'identity_mismatch'],
  [async()=>api('2118376946652557613','not_tibo','wrong'),'identity_mismatch'],
  [async()=>{throw new Error('private upstream message');},'error'],
  [async()=>new Response('not-json'),'error'],
  [async()=>new Response('x'.repeat(64001)),'error'],
 ];
 for(const [fetcher,status] of cases){const result=await enrichParent(reply(),fetcher,new AbortController().signal);assert.equal(result.parentStatus,status);assert.deepEqual(result.related,[]);assert(!JSON.stringify(result).includes('private upstream'));}
 const known={...reply(),related:[{relation:'reply' as const,id:'x:2118161370315448658',author:'person'}]};
 for(const parent of [api('2118161370315448658','other','wrong'),api('2118161370315448658','person','future',{created_timestamp:now+1})]){
  const result=await enrichParent(known,async()=>parent,new AbortController().signal);assert.equal(result.parentStatus,'identity_mismatch');assert.equal(result.related[0].text,undefined);
 }
});

test('a stalled parent request stops at four seconds without retry or blocking later normal work',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let start!:()=>void;const called=new Promise<void>(resolve=>start=resolve);let calls=0;
 const pending=enrichParent(reply(),async()=>{calls++;start();return new Promise<Response>(()=>{});},new AbortController().signal);
 await called;t.mock.timers.tick(4000);const result=await pending;
 assert.equal(result.parentStatus,'timeout');assert.deepEqual(result.related,[]);assert.equal(calls,1);
});

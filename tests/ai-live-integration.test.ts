import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runAction,type Store} from '../src/actions/run';
import type {Snapshot} from '../src/actions/sqlite';
import type {LiveOptions} from '../src/ai-live';
import type {LiveRecordStore} from '../src/actions/ai-live-store';

const START=Date.parse('2026-11-08T03:00:00Z')/1000;
const secrets={user:'u'.repeat(30),token:'t'.repeat(30)};
const API_KEY='fixture-live-key-never-persist';
const CHATTER='@ForwardEditor We hesitated to embed https://x.com into the codex app to make sense of the resets, but decided against it.';
type Category='announcement'|'attention'|'limit_change'|'chatter'|'unrelated';
const item=(id:string,text:string,time=START+60,title='')=>
 '<item><title>'+title+'</title><link>https://x.com/thsottiaux/status/'+id+'</link><pubDate>'+new Date(time*1000).toUTCString()+'</pubDate><description><![CDATA['+text+']]></description></item>';
const feed=(...items:string[])=>'<rss><channel><title>@thsottiaux</title>'+items.join('')+'</channel></rss>';
const result=(category:Category)=>({category,rationale:category==='chatter'?'一般的な雑談で新しい運用情報はありません。':'固定された試験用の理由。',confidence:0.91,uncertainty:''});
const response=(category:Category)=>Response.json({status:'completed',model:'gpt-6.1-sol',
 usage:{input_tokens:200,output_tokens:50,total_tokens:250,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:10}},
 output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result(category))}]}]});
const queue=(s:Snapshot)=>JSON.parse(s.tables.state.find(r=>r.key==='aiLiveQueue')?.value??'[]') as {id:string;queuedAt:number;fallback?:{code:string,at:number}}[];

class MemoryStore implements Store {
 state?:Snapshot;
 beforeSave?:(snapshot:Snapshot)=>void;
 constructor(initial?:Snapshot,readonly trace:string[]=[]){this.state=structuredClone(initial);}
 async load(initialize=false){this.trace.push('state-load');if(!this.state&&!initialize)throw Error('fixture_state_missing');return structuredClone(this.state);}
 async save(snapshot:Snapshot){this.trace.push('state-save');this.beforeSave?.(snapshot);this.state=structuredClone(snapshot);}
}
class MemoryLiveStore implements LiveRecordStore {
 records=new Map<string,Record<string,any>>();
 loads:string[]=[];
 beforeSave?:(id:string,record:Record<string,any>)=>void;
 failLoad=false;
 constructor(readonly trace:string[]=[]){}
 async load(id:string){this.loads.push(id);this.trace.push('live-load:'+id);if(this.failLoad)throw Error('live_store_error');return structuredClone(this.records.get(id));}
 async save(id:string,record:Record<string,any>){this.trace.push('live-save:'+id+':'+record.status);this.beforeSave?.(id,record);this.records.set(id,structuredClone(record));}
 clone(){const s=new MemoryLiveStore(this.trace);s.records=structuredClone(this.records);return s;}
}
function fixture(initial?:Snapshot,xml=feed(item('2',CHATTER)),trace:string[]=[]){
 const store=new MemoryStore(initial,trace),live=new MemoryLiveStore(trace),pushes:URLSearchParams[]=[];
 const fetcher=(async(input:any,init:any)=>{
  if(String(input)==='https://api.pushover.net/1/messages.json'){
   assert.ok(store.state?.tables.notifications.some(n=>n.status==='sending'),'delivery has a durable pre-send checkpoint');
   trace.push('push');pushes.push(new URLSearchParams(init.body));return Response.json({status:1});
  }
  assert.match(String(input),/^https:\/\/fxtwitter\.com\/thsottiaux\/feed\.xml\?/);
  trace.push('rss');return new Response(xml);
 }) as typeof fetch;
 const options=(ai:typeof fetch=async()=>response('chatter')):LiveOptions=>({
  enabled:true,model:'gpt-6.1-sol',reasoning:'medium',apiKey:API_KEY,store:live,fetcher:ai,
 });
 const run=(config:LiveOptions=options(),time=START+300)=>runAction('monitor',store,secrets,fetcher,time,undefined,config);
 return {store,live,pushes,fetcher,options,run,trace};
}
async function initialized(){
 const f=fixture(undefined,feed(item('1','An older baseline post.',START-100)));
 await runAction('test',f.store,secrets,f.fetcher,START);
 await runAction('monitor',f.store,secrets,f.fetcher,START);
 return structuredClone(f.store.state!);
}
function aiFor(f:ReturnType<typeof fixture>,category:Category,calls:{count:number}){
 return (async(_input:any,init:any)=>{
  const input=JSON.parse(JSON.parse(init.body).input);
  calls.count++;f.trace.push('ai:'+input.id);
  assert.equal(f.live.records.get(input.id)?.status,'claimed','AI must follow a durable per-post claim');
  assert.ok(queue(f.store.state!).some(q=>q.id===input.id),'new ID was enrolled before the paid call');
  return response(category);
 }) as typeof fetch;
}
function noSecrets(f:ReturnType<typeof fixture>){
 assert.equal(JSON.stringify(f.store.state).includes(API_KEY),false);
 assert.equal(JSON.stringify([...f.live.records.values()]).includes(API_KEY),false);
}

test('live OFF is byte-equivalent to conventional classifications, state and notification payloads',async()=>{
 const initial=await initialized(),normal=fixture(initial),f=fixture(initial);let calls=0;
 const expected=await runAction('monitor',normal.store,secrets,normal.fetcher,START+300);
 const actual=await f.run({...f.options(async()=>{calls++;throw Error('AI forbidden when OFF');}),enabled:false});
 assert.deepEqual(actual,expected);assert.deepEqual(f.store.state,normal.store.state);
 assert.deepEqual(f.pushes.map(p=>p.toString()),normal.pushes.map(p=>p.toString()));
 assert.equal(calls,0);assert.equal(f.live.loads.length,0);assert.equal(f.live.records.size,0);
});

test('a new low-value Candidate produces only one low-priority disagreement and preserves its machine classification',async()=>{
 const f=fixture(await initialized()),calls={count:0};
 await f.run(f.options(aiFor(f,'chatter',calls)));
 assert.equal(calls.count,1);assert.equal(f.pushes.length,1);
 assert.equal(f.pushes[0].get('priority'),'-1');
 assert.match(f.pushes[0].get('title')!,/判定不一致/);
 assert.match(f.pushes[0].get('message')!,/CANDIDATE/i);
 assert.match(f.pushes[0].get('message')!,/chatter|雑談/);
 assert.equal(f.pushes[0].get('url'),'https://x.com/thsottiaux/status/2');
 assert.equal(f.store.state!.tables.posts.find(p=>p.id==='x:2')?.classification,'CANDIDATE');
 assert.equal(f.live.records.get('x:2')?.result.category,'chatter');
 assert.equal(f.live.records.get('x:2')?.status,'complete');assert.equal(queue(f.store.state!).length,0);
 const restart=fixture(f.store.state);restart.live.records=structuredClone(f.live.records);
 await restart.run(restart.options(aiFor(restart,'chatter',calls)),START+600);
 assert.equal(calls.count,1);assert.equal(restart.pushes.length,0);
 noSecrets(f);
});

test('AI-only announcements and hints alert once; unimportant agreement sends nothing',async()=>{
 for(const category of ['announcement','attention','unrelated'] as const){
  const f=fixture(await initialized(),feed(item('2','Something is cooking 👀',START+60,'R to @someone'))),calls={count:0};
  await f.run(f.options(aiFor(f,category,calls)));
  assert.equal(calls.count,1,category);
  assert.equal(f.store.state!.tables.posts.find(p=>p.id==='x:2')?.classification,'IRRELEVANT');
  assert.equal(f.pushes.length,category==='unrelated'?0:1,category);
  if(f.pushes.length){
   assert.equal(f.pushes[0].get('priority'),category==='announcement'?'1':'0');
   assert.match(f.pushes[0].get('title')!,/判定不一致/);
   assert.match(f.pushes[0].get('message')!,/IRRELEVANT/);
  }
  assert.equal(queue(f.store.state!).length,0);noSecrets(f);
 }
});

test('Candidate and attention are substantive agreement, while Candidate to announcement is one upgraded alert',async()=>{
 for(const category of ['attention','announcement'] as const){
  const f=fixture(await initialized()),calls={count:0};
  await f.run(f.options(aiFor(f,category,calls)));
  assert.equal(f.pushes.length,1);assert.equal(f.pushes[0].get('priority'),category==='attention'?'0':'1');
  const text=f.pushes[0].get('title')!+'\n'+f.pushes[0].get('message')!;
  if(category==='attention')assert.doesNotMatch(text,/判定不一致/);else assert.match(text,/判定不一致/);
  assert.match(text,/CANDIDATE/i);assert.match(text,/attention|announcement|注意報|実施予告/);
 }
});

test('critical machine notifications precede blocked AI; only a disagreement adds a quiet follow-up',{timeout:5000},async()=>{
 for(const [text,category,priority] of [
  ['Resetting the usage limits tomorrow.','attention','1'],
  ['Banked 1/2','announcement','0'],
  ['Day 28/ Banked 2/2','announcement','0'],
  ['We doubled the Codex usage limits for Pro users.','unrelated','0'],
 ] as const){
  const f=fixture(await initialized(),feed(item('2',text)));
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const ai=(async()=>{
   enter();await gate;return response(category);
  }) as typeof fetch;
  const work=f.run(f.options(ai));
  try{
   assert.equal(await Promise.race([entered.then(()=>true),work.then(()=>false)]),true,'critical path must also evaluate AI');
   assert.equal(f.pushes.length,1,'machine notification arrived before AI returned');
   assert.equal(f.pushes[0].get('priority'),priority,'original critical priority is preserved');
  }finally{release();await work;}
  const disagreement=category!=='announcement';
  assert.equal(f.pushes.length,disagreement?2:1,text);
  if(disagreement){assert.equal(f.pushes[1].get('priority'),'-1');assert.match(f.pushes[1].get('title')!,/判定不一致/);}
  assert.equal(f.store.state!.tables.notifications.filter(n=>n.id==='post:x:2').length,1);
  if(disagreement)assert.equal(f.store.state!.tables.notifications.filter(n=>n.id==='ai-diff:x:2').length,1);
 }
});

test('already delivered Nov 8 chatter, baseline and reposts never enroll or replay',async()=>{
 const initial=await initialized(),past=fixture(initial,feed(item('2119308687676432672',CHATTER)));
 await runAction('monitor',past.store,secrets,past.fetcher,START+300);
 const before=structuredClone(past.store.state!);
 const f=fixture(before,feed(item('2119308687676432672',CHATTER),item('3','A late reset post.',START-50),item('4','Banked 1/2',START+61,'RT @someone')));
 let calls=0;
 await f.run(f.options(async()=>{calls++;return response('chatter');}),START+600);
 assert.equal(calls,0);assert.equal(f.pushes.length,0);assert.equal(f.live.records.size,0);
 assert.deepEqual(f.store.state!.tables.posts.find(p=>p.id==='x:2119308687676432672'),before.tables.posts.find(p=>p.id==='x:2119308687676432672'));
 assert.deepEqual(f.store.state!.tables.notifications,before.tables.notifications);
});

test('API unavailable is a conventional fallback, not a classification disagreement',async()=>{
 for(const failure of ['no-key','401','429','500','network','bad-json','timeout']){
  const f=fixture(await initialized());let calls=0;
  const ai=(async()=>{
   calls++;
   if(['401','429','500'].includes(failure))return Response.json({error:{message:'not logged'}},{status:Number(failure)});
   if(failure==='network')throw Error('upstream '+API_KEY);
   if(failure==='bad-json')return new Response('{');
   if(failure==='timeout')return new Promise<Response>(()=>{});
   return response('chatter');
  }) as typeof fetch;
  await f.run({...f.options(ai),apiKey:failure==='no-key'?'':API_KEY,requestMs:failure==='timeout'?20:45000});
  assert.equal(f.pushes.length,1,failure);assert.equal(f.pushes[0].get('priority'),'0');
  const message=f.pushes[0].get('title')!+'\n'+f.pushes[0].get('message')!;
  assert.match(message,/AI unavailable/i);assert.doesNotMatch(message,/判定不一致/);
  assert.equal(calls,failure==='no-key'?0:1);assert.equal(f.live.records.get('x:2')?.status,'complete');
  assert.ok(f.live.records.get('x:2')?.error);
  noSecrets(f);
 }
});

test('a burst is not restricted by the old two-per-run or ten-per-day comparison budgets',async()=>{
 const xml=feed(...Array.from({length:12},(_,i)=>item(String(i+10),'Unrelated original post '+i,START+60+i)));
 const f=fixture(await initialized(),xml),calls={count:0};
 await f.run(f.options(aiFor(f,'unrelated',calls)));
 assert.equal(calls.count,12);assert.equal(f.live.records.size,12);assert.equal(queue(f.store.state!).length,0);
 assert.equal(f.pushes.length,0);
 const next=fixture(f.store.state,feed(item('31','Another new unrelated original',START+601)));
 next.live.records=structuredClone(f.live.records);
 await next.run(next.options(aiFor(next,'unrelated',calls)),START+900);
 assert.equal(calls.count,13,'a same-day new post is not deferred until tomorrow');
});

test('lost decision acknowledgement resumes saved decisions, while an unresolved claim falls back without another API request',async()=>{
 for(const persisted of [false,true]){
  const f=fixture(await initialized()),calls={count:0};
  f.live.beforeSave=(id,record)=>{
   if(record.status==='decided'){
    if(persisted)f.live.records.set(id,structuredClone(record));
    throw Error('fixture_decision_write_uncertain');
   }
  };
  await f.run(f.options(aiFor(f,'chatter',calls))).catch(()=>{});
  assert.equal(calls.count,1);assert.equal(f.pushes.length,0,'do not notify from an unacknowledged AI decision');
  assert.equal(f.live.records.get('x:2')?.status,persisted?'decided':'claimed');
  assert.equal(queue(f.store.state!).length,1);
  const restart=fixture(f.store.state);restart.live.records=structuredClone(f.live.records);
  await restart.run(restart.options(aiFor(restart,'announcement',calls)),START+600);
  assert.equal(calls.count,1,'saved result or interrupted claim must not repeat the paid API');
  assert.equal(restart.pushes.length,1);
  if(persisted){assert.equal(restart.pushes[0].get('priority'),'-1');assert.match(restart.pushes[0].get('title')!,/判定不一致/);}
  else {assert.equal(restart.pushes[0].get('priority'),'0');assert.match(restart.pushes[0].get('message')!,/AI unavailable/i);}
  assert.equal(restart.live.records.get('x:2')?.status,'complete');assert.equal(queue(restart.store.state!).length,0);
 }
});

test('failed durable pre-send save never sends a Pushover or repeats the paid result on restart',async()=>{
 const f=fixture(await initialized()),calls={count:0};
 f.store.beforeSave=s=>{
  if(s.tables.notifications.some(n=>n.id==='post:x:2'&&n.status==='sending'))throw Error('fixture_pre_send_checkpoint_failed');
 };
 await f.run(f.options(aiFor(f,'attention',calls))).catch(()=>{});
 assert.equal(calls.count,1);assert.equal(f.pushes.length,0);
 const restart=fixture(f.store.state);restart.live.records=structuredClone(f.live.records);
 await restart.run(restart.options(aiFor(restart,'attention',calls)),START+600);
 assert.equal(calls.count,1,'a saved result is not classified twice');
 assert.ok(restart.pushes.length<=1,'no request was made before the failing checkpoint');
 assert.equal(f.store.state!.tables.notifications.find(n=>n.id==='test')?.status,'sent');
});

test('a lost post-delivery save keeps the durable sending claim and prevents a duplicate on restart',async()=>{
 const f=fixture(await initialized()),calls={count:0};
 f.store.beforeSave=s=>{
  if(s.tables.notifications.some(n=>n.id==='post:x:2'&&n.status==='sent'))throw Error('fixture_final_checkpoint_lost');
 };
 await f.run(f.options(aiFor(f,'attention',calls))).catch(()=>{});
 assert.equal(calls.count,1);assert.equal(f.pushes.length,1);
 assert.equal(f.store.state!.tables.notifications.find(n=>n.id==='post:x:2')?.status,'sending');
 const restart=fixture(f.store.state);restart.live.records=structuredClone(f.live.records);
 await restart.run(restart.options(aiFor(restart,'attention',calls)),START+600);
 assert.equal(calls.count,1);assert.equal(restart.pushes.length,0,'unknown previous delivery cannot be resent automatically');
 assert.ok(['sending','unknown'].includes(restart.store.state!.tables.notifications.find(n=>n.id==='post:x:2')?.status));
});

test('job time exhaustion leaves all unstarted posts durable and a fresh run drains them without new RSS posts',async()=>{
 const xml=feed(...Array.from({length:6},(_,i)=>item(String(i+10),'An ordinary post '+i,START+60+i)));
 const f=fixture(await initialized(),xml),calls={count:0};
 await f.run({...f.options(aiFor(f,'unrelated',calls)),runMs:1});
 assert.equal(calls.count,0);assert.equal(queue(f.store.state!).length,6);assert.equal(f.pushes.length,0);
 const restart=fixture(f.store.state,xml);restart.live.records=structuredClone(f.live.records);
 await restart.run(restart.options(aiFor(restart,'unrelated',calls)),START+600);
 assert.equal(calls.count,6);assert.equal(queue(restart.store.state!).length,0);
 assert.equal(restart.store.state!.tables.posts.length,7,'restart did not duplicate posts');
});

test('missing reply parent stays explicit and does not prevent classifying the post itself',async()=>{
 const f=fixture(await initialized(),feed(item('2','?!',START+60,'R to @someone')));let calls=0;
 const ai=(async(_input:any,init:any)=>{
  calls++;const input=JSON.parse(JSON.parse(init.body).input);
  assert.equal(input.parentStatus,'unavailable');assert.deepEqual(input.related,[]);
  return response('unrelated');
 }) as typeof fetch;
 await f.run({...f.options(ai),enrich:async candidate=>({...candidate,parentStatus:'unavailable'})});
 assert.equal(calls,1);assert.equal(f.pushes.length,0);assert.equal(queue(f.store.state!).length,0);
});

test('AI ledger outage uses a recorded mechanical fallback and never causes a later speculative reclassification',async()=>{
 const f=fixture(await initialized()),calls={count:0};f.live.failLoad=true;
 await f.run(f.options(aiFor(f,'chatter',calls)));
 assert.equal(calls.count,0);assert.equal(f.pushes.length,1);
 assert.match(f.pushes[0].get('message')!,/AI unavailable/i);
 assert.equal(queue(f.store.state!).length,1,'failed independent write stays visible for reconciliation');
 assert.ok(queue(f.store.state!)[0].fallback?.code);
 const restart=fixture(f.store.state);
 await restart.run(restart.options(aiFor(restart,'announcement',calls)),START+600);
 assert.equal(calls.count,0,'fallback marker prevents paying later to reconsider an already handled failure');
 assert.equal(restart.pushes.length,0);assert.equal(queue(restart.store.state!).length,0);
 assert.equal(restart.live.records.get('x:2')?.status,'complete');
});

test('check, one-time test and explicit recover keep their conventional behavior without invoking live AI',async()=>{
 const initial=await initialized(),sent=fixture(initial,feed(item('2','Resetting the usage limits tomorrow.')));
 await runAction('monitor',sent.store,secrets,sent.fetcher,START+300);
 for(const mode of ['check','test','recover'] as const){
  const f=fixture(sent.store.state),normal=fixture(sent.store.state);let calls=0;
  f.live.failLoad=true;
  const id=mode==='recover'?'x:2':undefined;
  const expected=await runAction(mode,normal.store,secrets,normal.fetcher,START+600,id);
  const actual=await runAction(mode,f.store,secrets,f.fetcher,START+600,id,f.options(async()=>{calls++;throw Error('AI forbidden outside monitor');}));
  assert.deepEqual(actual,expected);assert.deepEqual(f.store.state,normal.store.state);
  assert.deepEqual(f.pushes.map(p=>p.toString()),normal.pushes.map(p=>p.toString()));
  assert.equal(calls,0);assert.equal(f.live.loads.length,0);
 }
});

test('burst API calls can overlap while all shared-branch writes and notification transactions stay serial',async()=>{
 const xml=feed(...Array.from({length:6},(_,i)=>item(String(i+10),'Something is cooking '+i)));
 const f=fixture(await initialized(),xml);
 let writes=0,maxWrites=0,apiActive=0,maxApi=0,pushActive=0,maxPush=0;
 const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
 const writing=async(work:()=>Promise<void>)=>{
  writes++;maxWrites=Math.max(maxWrites,writes);
  try{await delay(2);await work();}finally{writes--;}
 };
 const normalSave=f.store.save.bind(f.store),liveSave=f.live.save.bind(f.live);
 f.store.save=s=>writing(()=>normalSave(s));
 f.live.save=(id,record)=>writing(()=>liveSave(id,record));
 const ai=(async()=>{
  apiActive++;maxApi=Math.max(maxApi,apiActive);
  try{await delay(45);return response('attention');}finally{apiActive--;}
 }) as typeof fetch;
 const network=(async(input:any,init:any)=>{
  if(String(input).includes('pushover.net')){
   pushActive++;maxPush=Math.max(maxPush,pushActive);
   try{await delay(8);return await f.fetcher(input,init);}finally{pushActive--;}
  }
  return f.fetcher(input,init);
 }) as typeof fetch;
 await runAction('monitor',f.store,secrets,network,START+300,undefined,f.options(ai));
 assert.equal(maxWrites,1,'state and per-post records share one branch and cannot race PUTs');
 assert.equal(maxPush,1,'normal DB delivery transactions cannot overlap');
 assert.ok(maxApi>1&&maxApi<=3,'bounded parallel inference avoids serial burst latency');
 assert.equal(f.pushes.length,6);assert.equal(queue(f.store.state!).length,0);
 assert.equal(f.store.state!.tables.notifications.filter(n=>n.kind==='alert'&&n.status==='sent').length,6);
});

test('a queued critical post still sends its original urgent alert before AI when the next RSS fetch fails',async()=>{
 const first=fixture(await initialized(),feed(item('2','Resetting the usage limits tomorrow.')));
 let calls=0;
 const ai=(async()=>{calls++;return response('chatter');}) as typeof fetch;
 await first.run({...first.options(ai),runMs:-1});
 assert.equal(first.pushes.length,0);assert.equal(calls,0);
 assert.deepEqual(queue(first.store.state!).map(q=>q.id),['x:2']);
 assert.equal(first.store.state!.tables.notifications.some(n=>n.id==='post:x:2'),false);
 const restart=fixture(first.store.state);
 const offline=(async(input:any,init:any)=>String(input).includes('pushover.net')
  ?restart.fetcher(input,init):new Response('not found',{status:404})) as typeof fetch;
 const afterUrgent=(async()=>{
  calls++;restart.trace.push('ai');
  assert.equal(restart.pushes.length,1,'urgent rule alert must precede AI despite an offline RSS source');
  assert.equal(restart.pushes[0].get('priority'),'1');
  assert.match(restart.pushes[0].get('title')!,/💣/);
  return response('chatter');
 }) as typeof fetch;
 await runAction('monitor',restart.store,secrets,offline,START+600,undefined,restart.options(afterUrgent));
 assert.equal(calls,1);assert.equal(restart.pushes.length,2);
 assert.equal(restart.pushes[1].get('priority'),'-1');
 assert.match(restart.pushes[1].get('title')!,/判定不一致/);
 assert.ok(restart.trace.indexOf('push')<restart.trace.indexOf('ai'));
 assert.equal(restart.store.state!.tables.source_health[0].error,'http_404');
 assert.equal(restart.store.state!.tables.notifications.find(n=>n.id==='post:x:2')?.status,'sent');
 assert.equal(restart.store.state!.tables.notifications.find(n=>n.id==='ai-diff:x:2')?.status,'sent');
 assert.equal(queue(restart.store.state!).length,0);
 await runAction('monitor',restart.store,secrets,offline,START+900,undefined,restart.options(afterUrgent));
 assert.equal(calls,1);assert.equal(restart.pushes.length,2,'an offline restart cannot replay either notification');
});

test('turning live AI OFF closes its queue with conventional delivery, and ON never reclassifies the closed old post',async()=>{
 const initial=fixture(await initialized());
 let calls=0;
 const forbidden=(async()=>{calls++;throw Error('closed work must not call AI');}) as typeof fetch;
 await initial.run({...initial.options(forbidden),runMs:-1});
 assert.equal(calls,0);assert.equal(initial.pushes.length,0);assert.equal(queue(initial.store.state!).length,1);
 const testReceipt=structuredClone(initial.store.state!.tables.notifications.find(n=>n.id==='test'));
 const conventional=fixture(initial.store.state),off=fixture(initial.store.state);
 await runAction('monitor',conventional.store,secrets,conventional.fetcher,START+600);
 await off.run({...off.options(forbidden),enabled:false},START+600);
 assert.equal(calls,0);assert.equal(off.live.loads.length,0);
 assert.deepEqual(off.pushes.map(p=>p.toString()),conventional.pushes.map(p=>p.toString()));
 assert.equal(off.pushes.length,1);assert.equal(off.pushes[0].get('priority'),'0');
 assert.equal(queue(off.store.state!).length,0);
 assert.ok(off.store.state!.tables.events.some(e=>e.event_type==='ai_live_disabled'));
 assert.deepEqual(off.store.state!.tables.notifications.find(n=>n.id==='test'),testReceipt);
 const on=fixture(off.store.state);
 await on.run(on.options(forbidden),START+900);
 assert.equal(calls,0);assert.equal(on.pushes.length,0);assert.equal(on.live.records.size,0);
 assert.equal(on.store.state!.tables.notifications.filter(n=>n.id==='post:x:2').length,1);
 const next=fixture(on.store.state,feed(item('3',CHATTER,START+1001)));
 const fresh=(async(_input:any,init:any)=>{
  calls++;assert.equal(JSON.parse(JSON.parse(init.body).input).id,'x:3');
  return response('chatter');
 }) as typeof fetch;
 await next.run(next.options(fresh),START+1200);
 assert.equal(calls,1);assert.equal(next.pushes.length,1);assert.equal(next.pushes[0].get('priority'),'-1');
 assert.equal(next.store.state!.tables.notifications.filter(n=>n.id==='post:x:2').length,1);
});






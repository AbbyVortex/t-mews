import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runAction, type Store, type ActionMode} from '../src/actions/run';
import {runActionWithShadow} from '../src/actions/ai-shadow';
import type {Snapshot} from '../src/actions/sqlite';
import type {ShadowState, ShadowStore} from '../src/ai-shadow';

const START=Date.parse('2026-10-30T03:00:00Z')/1000;
const secrets={user:'u'.repeat(30),token:'t'.repeat(30)};
const API_KEY='fixture-shadow-key-never-persist';
const item=(id:string,text:string,publishedAt=START+60,title='')=>
 `<item><title>${title}</title><link>https://x.com/thsottiaux/status/${id}</link><pubDate>${new Date(publishedAt*1000).toUTCString()}</pubDate><description><![CDATA[${text}]]></description></item>`;
const feed=(...items:string[])=>`<rss><channel><title>@thsottiaux</title>${items.join('')}</channel></rss>`;
const response=()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({
 category:'attention',rationale:'A possible hint in this fixture.',confidence:0.7,uncertainty:'No explicit announcement.'
})}]}]});

class MemoryStore implements Store {
 state?:Snapshot; saves=0; failSaveAt=0;
 constructor(initial?:Snapshot,readonly trace:string[]=[]){this.state=structuredClone(initial);}
 async load(initialize=false){this.trace.push('normal-load');if(!this.state&&!initialize)throw Error('missing fixture state');return structuredClone(this.state);}
 async save(snapshot:Snapshot){
  this.trace.push('normal-save');this.saves++;
  if(this.saves===this.failSaveAt)throw Error('fixture normal checkpoint failed');
  this.state=structuredClone(snapshot);
 }
}
class MemoryShadowStore implements ShadowStore {
 state?:ShadowState; loads=0; saves=0; failLoad=false; failSaveAt=0;
 constructor(initial?:ShadowState,readonly trace:string[]=[]){this.state=structuredClone(initial);}
 async load(_signal:AbortSignal){this.trace.push('shadow-load');this.loads++;if(this.failLoad)throw Error('fixture shadow read failed');return structuredClone(this.state);}
 async save(state:ShadowState,_signal:AbortSignal){
  this.trace.push('shadow-save');this.saves++;
  if(this.saves===this.failSaveAt)throw Error('fixture shadow checkpoint failed');
  this.state=structuredClone(state);
 }
}
function normalFixture(initial?:Snapshot,xml=feed(item('2','Resetting the usage limits tomorrow.')),trace:string[]=[]){
 const store=new MemoryStore(initial,trace),pushes:string[]=[];
 const fetcher=(async(input:any,init:any)=>{
  if(String(input)==='https://api.pushover.net/1/messages.json'){
   trace.push('push');
   assert.ok(store.state?.tables.notifications.some(row=>row.status==='sending'));
   pushes.push(String(init.body));return Response.json({status:1});
  }
  assert.match(String(input),/^https:\/\/fxtwitter\.com\/thsottiaux\/feed\.xml\?/);
  trace.push('rss');return new Response(xml);
 }) as typeof fetch;
 return {store,pushes,fetcher,trace};
}
function shadowOptions(store:ShadowStore,fetcher:typeof fetch=async()=>response()){
 return {enabled:true,model:'fixture-model',apiKey:API_KEY,store,fetcher};
}
async function initialized(){
 const f=normalFixture(undefined,feed(item('1','An older baseline fixture.',START-100)));
 await runAction('test',f.store,secrets,f.fetcher,START);
 await runAction('monitor',f.store,secrets,f.fetcher,START);
 return structuredClone(f.store.state!);
}

test('shadow OFF, ON and API failures preserve the exact conventional snapshot and push payload',async()=>{
 const initial=await initialized(),normal=normalFixture(initial);
 const expected=await runAction('monitor',normal.store,secrets,normal.fetcher,START+300);
 for(const scenario of ['off','no-key','ok','http-error','network-error','invalid-result']){
  const f=normalFixture(initial),shadow=new MemoryShadowStore();let calls=0;
  const ai=(async()=>{
   calls++;assert.equal(shadow.state?.records.at(-1)?.status,'claimed','durable claim precedes API');
   if(scenario==='http-error')return Response.json({error:{message:'fixture rate limit'}},{status:429});
   if(scenario==='network-error')throw new TypeError('fixture AI network failed');
   if(scenario==='invalid-result')return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'not JSON'}]}]});
   return response();
  }) as typeof fetch;
  const config={...shadowOptions(shadow,ai),enabled:scenario!=='off',apiKey:scenario==='no-key'?'':API_KEY};
  const result=await runActionWithShadow('monitor',f.store,secrets,f.fetcher,START+300,undefined,config);
  assert.deepEqual(result,expected,scenario);
  assert.deepEqual(f.store.state,normal.store.state,scenario);
  assert.deepEqual(f.pushes,normal.pushes,scenario);
  assert.equal(calls,['off','no-key'].includes(scenario)?0:1,scenario);
  if(['off','no-key'].includes(scenario)){assert.equal(shadow.loads,0);assert.equal(shadow.saves,0);}
  assert.equal(JSON.stringify(f.store.state).includes(API_KEY),false);
  assert.equal(JSON.stringify(shadow.state??{}).includes(API_KEY),false);
 }
});

test('conventional delivery and final checkpoint complete before a blocked shadow read', {timeout:4000},async()=>{
 const initial=await initialized(),expected=normalFixture(initial);
 await runAction('monitor',expected.store,secrets,expected.fetcher,START+300);
 const trace:string[]=[],f=normalFixture(initial,undefined,trace),shadow=new MemoryShadowStore(undefined,trace);
 let entered!:()=>void,release!:()=>void,completed=false;
 const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const originalLoad=shadow.load.bind(shadow);
 shadow.load=async signal=>{entered();await gate;return originalLoad(signal);};
 const work=runActionWithShadow('monitor',f.store,secrets,f.fetcher,START+300,undefined,shadowOptions(shadow)).finally(()=>{completed=true;});
 try{
  await started;
  assert.equal(completed,false);
  assert.deepEqual(f.pushes,expected.pushes);
  assert.deepEqual(f.store.state,expected.store.state,'the final sent receipt is already durable');
  assert.equal(trace.at(-1),'normal-save');
  assert.ok(trace.lastIndexOf('normal-save')>trace.indexOf('push'));
 }finally{release();await work;}
 assert.ok(trace.indexOf('shadow-load')>trace.lastIndexOf('normal-save'));
});

test('test, check and recover modes never contact shadow storage or the AI service',async()=>{
 const initial=await initialized(),sent=normalFixture(initial);
 await runAction('monitor',sent.store,secrets,sent.fetcher,START+300);
 for(const mode of ['test','check','recover'] satisfies ActionMode[]){
  const f=normalFixture(sent.store.state),normal=normalFixture(sent.store.state),shadow=new MemoryShadowStore();let aiCalls=0;
  shadow.failLoad=true;
  const config=shadowOptions(shadow,(async()=>{aiCalls++;throw Error('must not call AI');}) as typeof fetch);
  const postId=mode==='recover'?'x:2':undefined;
  const expected=await runAction(mode,normal.store,secrets,normal.fetcher,START+600,postId);
  assert.deepEqual(await runActionWithShadow(mode,f.store,secrets,f.fetcher,START+600,postId,config),expected);
  assert.deepEqual(f.store.state,normal.store.state);assert.deepEqual(f.pushes,normal.pushes);
  assert.equal(shadow.loads,0);assert.equal(shadow.saves,0);assert.equal(aiCalls,0);
 }
});

test('only new non-baseline non-reposts enter shadow, including a reply with no reset keyword',async()=>{
 const f=normalFixture(undefined,feed(item('1','An old reset announcement.',START-100)));
 await runAction('test',f.store,secrets,f.fetcher,START);
 const shadow=new MemoryShadowStore();let calls=0;
 const config=shadowOptions(shadow,(async()=>{calls++;return response();}) as typeof fetch);
 await runActionWithShadow('monitor',f.store,secrets,f.fetcher,START,undefined,config);
 assert.equal(calls,0,'bootstrap is excluded');
 const xml=feed(item('1','An old reset announcement.',START-100),
  item('2','A late historical announcement.',START-60),
  item('3','Resetting limits tomorrow.',START+60,'RT @someone'),
  item('4','Something is cooking 👀',START+90,'R to @someone'));
 const next=normalFixture(f.store.state,xml);
 await runActionWithShadow('monitor',next.store,secrets,next.fetcher,START+300,undefined,config);
 assert.equal(next.store.state!.tables.posts.find(row=>row.id==='x:2')?.baseline,1);
 assert.equal(next.store.state!.tables.posts.find(row=>row.id==='x:3')?.kind,'repost');
 assert.equal(next.store.state!.tables.posts.find(row=>row.id==='x:4')?.notification_status,'not_relevant');
 assert.equal(next.store.state!.tables.posts.find(row=>row.id==='x:4')?.kind,'reply');
 assert.equal(calls,1);assert.deepEqual(shadow.state?.records.map(row=>row.id),['x:4']);
 assert.deepEqual(next.pushes,[]);
});

test('fresh runners retain claims and do not replay classified or failed new posts',async()=>{
 for(const fail of [false,true]){
  const initial=await initialized(),f=normalFixture(initial),shadow=new MemoryShadowStore();let calls=0;
  const ai=(async()=>{calls++;if(fail)throw new TypeError('fixture response lost');return response();}) as typeof fetch;
  await runActionWithShadow('monitor',f.store,secrets,f.fetcher,START+300,undefined,shadowOptions(shadow,ai));
  assert.equal(calls,1);assert.equal(shadow.state?.records.length,1);
  const saved=structuredClone(shadow.state),restartedShadow=new MemoryShadowStore(saved),next=normalFixture(f.store.state);
  await runActionWithShadow('monitor',next.store,secrets,next.fetcher,START+600,undefined,shadowOptions(restartedShadow,ai));
  assert.equal(calls,1);assert.deepEqual(next.pushes,[]);assert.deepEqual(restartedShadow.state,saved);
  assert.equal(next.store.state!.tables.posts.length,2);
 }
});

test('shadow read, claim-save and result-save failures cannot alter conventional success',async()=>{
 const initial=await initialized(),normal=normalFixture(initial);
 const expected=await runAction('monitor',normal.store,secrets,normal.fetcher,START+300);
 for(const failure of ['load','claim','result']){
  const f=normalFixture(initial),shadow=new MemoryShadowStore();let calls=0;
  shadow.failLoad=failure==='load';shadow.failSaveAt=failure==='claim'?1:failure==='result'?2:0;
  const ai=(async()=>{calls++;return response();}) as typeof fetch;
  assert.deepEqual(await runActionWithShadow('monitor',f.store,secrets,f.fetcher,START+300,undefined,shadowOptions(shadow,ai)),expected,failure);
  assert.deepEqual(f.store.state,normal.store.state,failure);assert.deepEqual(f.pushes,normal.pushes,failure);
  assert.equal(calls,failure==='result'?1:0,failure);
  if(failure==='result')assert.equal(shadow.state?.records[0]?.status,'claimed');
 }
});

test('a failed conventional final checkpoint never starts shadow work',async()=>{
 const initial=await initialized(),f=normalFixture(initial),shadow=new MemoryShadowStore();let calls=0;
 f.store.failSaveAt=2;
 await assert.rejects(runActionWithShadow('monitor',f.store,secrets,f.fetcher,START+300,undefined,
  shadowOptions(shadow,(async()=>{calls++;return response();}) as typeof fetch)),/fixture normal checkpoint failed/);
 assert.equal(f.pushes.length,1);assert.equal(shadow.loads,0);assert.equal(shadow.saves,0);assert.equal(calls,0);
});

test('a run compares at most two new posts without delaying or limiting conventional alerts',async()=>{
 const initial=await initialized(),xml=feed(...['2','3','4'].map(id=>item(id,`Resetting the usage limits tomorrow. Fixture ${id}.`)));
 const normal=normalFixture(initial,xml),f=normalFixture(initial,xml),shadow=new MemoryShadowStore();let calls=0;
 const expected=await runAction('monitor',normal.store,secrets,normal.fetcher,START+300);
 const result=await runActionWithShadow('monitor',f.store,secrets,f.fetcher,START+300,undefined,
  shadowOptions(shadow,(async()=>{calls++;return response();}) as typeof fetch));
 assert.equal(calls,2);assert.equal(shadow.state?.records.length,2);
 assert.equal(f.pushes.length,3);assert.deepEqual(f.pushes,normal.pushes);
 assert.deepEqual(result,expected);assert.deepEqual(f.store.state,normal.store.state);
});

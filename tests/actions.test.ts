import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runAction,type Store} from '../src/actions/run';
import {LocalD1,type Snapshot} from '../src/actions/sqlite';
import {GitHubStateStore} from '../src/actions/store';
import type {RadarSignal} from '../src/radar-watch';
const start=Date.parse('2026-09-08T07:00:00Z')/1000;
const secrets={user:'u'.repeat(30),token:'t'.repeat(30)};
const xml=(id:string,text:string,now=start+60)=>`<rss><channel><title>@thsottiaux</title><item><link>https://x.com/thsottiaux/status/${id}</link><pubDate>${new Date(now*1000).toUTCString()}</pubDate><description><![CDATA[${text}]]></description></item></channel></rss>`;
test('RSS check works before any secrets or baseline exist',async()=>{
 const store={load:async()=>{throw new Error('must not load state')},save:async()=>{throw new Error('must not save state')}};
 assert.deepEqual(await runAction('check',store,{user:'',token:''},async()=>new Response(xml('1','Codex'))),{source:'fxtwitter',items:1});
});
class MemoryStore implements Store {
 state?:Snapshot; fail=false;
 async load(init=false){if(!this.state&&!init)throw new Error('missing');return structuredClone(this.state);}
 async save(s:Snapshot){if(this.fail)throw new Error('durable store unavailable');this.state=structuredClone(s);}
}
test('Actions: test once, persisted baseline, new alert once across fresh runners, no secrets in snapshot',async()=>{
 const store=new MemoryStore();const messages:string[]=[];let feed=xml('1','Resetting the limits tomorrow.',start-100);
 const fetcher=(async(input:any)=>{
  if(String(input).includes('pushover')) {
   assert.ok(store.state?.tables.notifications.some(r=>r.status==='sending'),'claim must be persisted before send');
   messages.push('push');return Response.json({status:1});
  }return new Response(feed);
 }) as typeof fetch;
 await runAction('test',store,secrets,fetcher,start);await runAction('test',store,secrets,fetcher,start);
 assert.equal(messages.length,1);
 await runAction('monitor',store,secrets,fetcher,start);assert.equal(messages.length,2);
 feed=xml('2',"Who says it won't reset in a while 👀");
 await runAction('monitor',store,secrets,fetcher,start+300);await runAction('monitor',store,secrets,fetcher,start+600);
 assert.equal(messages.length,3);assert.equal(store.state?.tables.posts.length,2);
 assert.ok(!JSON.stringify(store.state).includes(secrets.user));assert.ok(!JSON.stringify(store.state).includes(secrets.token));
});
test('Actions: persistence failure prevents delivery; lost delivery response never retries',async()=>{
 const store=new MemoryStore();store.fail=true;let calls=0;
 const fetcher=(async()=>{calls++;throw new Error('network failure');}) as typeof fetch;
 await assert.rejects(runAction('test',store,secrets,fetcher,start));assert.equal(calls,0);
 store.fail=false;await assert.rejects(runAction('test',store,secrets,fetcher,start));assert.equal(calls,1);
 await assert.rejects(runAction('test',store,secrets,fetcher,start));assert.equal(calls,1);
});
test('Actions: a slow durable checkpoint does not consume the delivery timeout',async t=>{
 const controllers:AbortController[]=[];
 t.mock.method(AbortSignal,'timeout',(milliseconds:number)=>{
  assert.equal(milliseconds,8000);
  const controller=new AbortController();controllers.push(controller);return controller.signal;
 });
 class SlowCheckpointStore extends MemoryStore {
  override async save(snapshot:Snapshot) {
   if(snapshot.tables.notifications.some(n=>n.id==='test'&&n.status==='sending')) {
    // Simulate the original timeout expiring while GitHub persists the claim.
    assert.equal(controllers.length,1);
    controllers[0].abort(new DOMException('Checkpoint outlasted the original timer','TimeoutError'));
   }
   await super.save(snapshot);
  }
 }
 const store=new SlowCheckpointStore();let calls=0;
 const fetcher=(async(_input:any,init:any)=>{
  calls++;
  assert.equal(store.state?.tables.notifications.find(n=>n.id==='test')?.status,'sending');
  assert.equal(controllers[0].signal.aborted,true);
  assert.equal(controllers.length,2,'delivery gets a fresh timer after the checkpoint');
  assert.equal(init.signal,controllers[1].signal);
  assert.equal(init.signal.aborted,false);
  return Response.json({status:1});
 }) as typeof fetch;
 await runAction('test',store,secrets,fetcher,start);
 assert.equal(calls,1);
 assert.equal(store.state?.tables.notifications.find(n=>n.id==='test')?.status,'sent');
});

test('Actions: no test means no monitoring; missing or invalid state fails closed',async()=>{
 await assert.rejects(runAction('monitor',new MemoryStore(),secrets));
 assert.throws(()=>new LocalD1({version:2,tables:{}} as any));
 const store=new MemoryStore();const db=new LocalD1();store.state=db.snapshot();db.close();
 await assert.rejects(runAction('monitor',store,secrets,async()=>{throw new Error('must not fetch')}));
});
test('Actions: an outage warned before the update recovers silently and keeps its notification history',async()=>{
 const store=new MemoryStore();const titles:string[]=[];
 const fetcher=(async(input:any,init:any)=>{
  if(String(input).includes('pushover')){titles.push(new URLSearchParams(init.body).get('title')!);return Response.json({status:1});}
  return new Response(xml('1','Codex performance',start-100));
 }) as typeof fetch;
 await runAction('test',store,secrets,fetcher,start);await runAction('monitor',store,secrets,fetcher,start);
 const outage=start+300;
 const warning={id:`offline:${outage}`,post_id:null,kind:'offline',created_at:start+1200,status:'sent',sent_at:start+1200};
 store.state!.tables.notifications.push(warning);
 store.state!.tables.state.push({key:'outage',value:String(outage)},{key:'recoverySince',value:String(start+1500)});
 await runAction('monitor',store,secrets,fetcher,start+2100);
 assert.equal(titles.length,2);
 assert.equal(store.state!.publicStatus?.sourceState,'online');
 assert.deepEqual(store.state!.tables.notifications.find(row=>row.id===warning.id),warning);
 assert.equal(store.state!.tables.state.some(row=>['outage','recoverySince'].includes(row.key)),false);
});

test('Actions: primary operation survives the legacy five-day expiry and retains delivery dedup',async()=>{
 const store=new MemoryStore();let feed=xml('1','Codex performance',start-100);let pushes=0;
 const fetcher=(async(input:any)=>{
  if(String(input).includes('pushover')){pushes++;return Response.json({status:1});}
  return new Response(feed);
 }) as typeof fetch;
 await runAction('test',store,secrets,fetcher,start);await runAction('monitor',store,secrets,fetcher,start);
 const baseline=store.state!.tables.state.find(r=>r.key==='baselineAt')!.value;
 const legacyEnd=String(start+5*86400);
 store.state!.tables.state.push({key:'actionsEndAt',value:legacyEnd});
 for(const day of [6,61]) {
  feed=xml(String(day),'Resetting the usage limits tomorrow.',start+day*86400-60);
  await runAction('monitor',store,secrets,fetcher,start+day*86400);
  await runAction('monitor',store,secrets,fetcher,start+day*86400+300);
 }
 assert.equal(pushes,4,'one test, one online and two distinct post alerts');
 assert.equal(store.state!.tables.state.find(r=>r.key==='baselineAt')!.value,baseline);
 assert.equal(store.state!.tables.state.find(r=>r.key==='actionsEndAt')!.value,legacyEnd);
 assert.equal(store.state!.tables.notifications.filter(r=>r.status==='sent').length,4);
});
test('GitHub store uses CAS, rejects private repos and missing state',async()=>{
 const privateFetch=(async()=>Response.json({private:true})) as typeof fetch;
 await assert.rejects(new GitHubStateStore('user/repo','token',privateFetch).load(true),/public/);
 let put:any;
 const db=new LocalD1();const snapshot=db.snapshot();db.close();
 const mock=(async(input:any,init:any)=>{
  const url=String(input);
  if(init.method==='PUT'){put=JSON.parse(init.body);return Response.json({content:{sha:'next-sha'}});}
  if(url.endsWith('/user/repo'))return Response.json({private:false,default_branch:'main'});
  if(url.includes('/git/ref/'))return Response.json({object:{sha:'ref-sha'}});
  return Response.json({sha:'old-sha',encoding:'base64',content:Buffer.from(JSON.stringify(snapshot)).toString('base64')});
 }) as typeof fetch;
 const store=new GitHubStateStore('user/repo','token',mock);await store.load();snapshot.tables.state.push({key:'sample',value:'true'});await store.save(snapshot);
 assert.equal(put.sha,'old-sha');assert.equal(put.branch,'monitor-state');assert.ok(!put.content.includes('token'));
});

test('radar: baseline stays silent; failed publication recovers from the durable state without replaying posts',async()=>{
 class RadarStore extends MemoryStore {
  signals:RadarSignal[]=[];
  async publishRadar(signal:RadarSignal){
   assert.equal(JSON.parse(this.state!.tables.state.find(r=>r.key==='radarWatch')!.value).id,signal.id);
   this.signals.push(structuredClone(signal));
   if(this.signals.length===1)throw Error('fixture projection failure');
  }
 }
 const store=new RadarStore();let rss=xml('1','Banked 1/2',start-100);let sends=0;
 const fetcher:typeof fetch=async input=>{
  if(String(input).includes('pushover')){sends++;return Response.json({status:1});}
  return new Response(rss);
 };
 await runAction('test',store,secrets,fetcher,start);
 await runAction('monitor',store,secrets,fetcher,start);
 assert.equal(store.signals.length,0);
 rss=xml('2','Banked 2/2',start+100);
 await assert.rejects(runAction('monitor',store,secrets,fetcher,start+300),/projection failure/);
 const beforeRetry=sends;
 await runAction('monitor',store,secrets,fetcher,start+600);
 await runAction('monitor',store,secrets,fetcher,start+900);
 assert.deepEqual(store.signals.map(s=>s.id),['x:2','x:2']);
 assert.deepEqual(store.signals[0],store.signals[1]);
 assert.equal(store.signals[0].observedAt,(start+300)*1000);
 assert.equal(sends,beforeRetry);
});

test('radar: a GitHub PUT with a lost acknowledgement is idempotent and a new post uses its own file SHA',async()=>{
 const writes:{sha?:string;branch:string;content:string}[]=[];
 const fetcher:typeof fetch=async (url,init)=>{
  assert.ok(String(url).includes('/contents/radar-watch.json'));
  if(init?.method==='PUT'){writes.push(JSON.parse(String(init.body)));return Response.json({});}
  const last=writes.at(-1);
  return last?Response.json({sha:'existing-radar-sha',encoding:'base64',content:last.content}):new Response(null,{status:404});
 };
 const store=new GitHubStateStore('user/repo','fixture-token',fetcher);
 const signal:RadarSignal={version:1,id:'x:200',kind:'hint',dueAt:null,publishedAt:start*1000,observedAt:start*1000+1000};
 await store.publishRadar(signal);await store.publishRadar(signal);await store.publishRadar({...signal,id:'x:201'});
 assert.equal(writes.length,2);assert.equal(writes[1].sha,'existing-radar-sha');
 assert.equal(writes[1].branch,'monitor-state');
 assert.deepEqual(JSON.parse(Buffer.from(writes[1].content,'base64').toString()),{...signal,id:'x:201'});
});

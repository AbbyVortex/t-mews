import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runAction,type Store} from '../src/actions/run';
import {LocalD1,type Snapshot} from '../src/actions/sqlite';
import {GitHubStateStore} from '../src/actions/store';
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
test('Actions: no test means no monitoring; missing or invalid state fails closed',async()=>{
 await assert.rejects(runAction('monitor',new MemoryStore(),secrets));
 assert.throws(()=>new LocalD1({version:2,tables:{}} as any));
 const store=new MemoryStore();const db=new LocalD1();store.state=db.snapshot();db.close();
 await assert.rejects(runAction('monitor',store,secrets,async()=>{throw new Error('must not fetch')}));
});
test('Actions: temporary RSS failure and recovery across delayed runs',async()=>{
 const store=new MemoryStore();let outage=false;const titles:string[]=[];
 const fetcher=(async(input:any,init:any)=>{
  if(String(input).includes('pushover')){titles.push(new URLSearchParams(init.body).get('title')!);return Response.json({status:1});}
  return outage?new Response('',{status:503}):new Response(xml('1','Codex performance',start-100));
 }) as typeof fetch;
 await runAction('test',store,secrets,fetcher,start);await runAction('monitor',store,secrets,fetcher,start);
 outage=true;await runAction('monitor',store,secrets,fetcher,start+300);await runAction('monitor',store,secrets,fetcher,start+900);
 assert.equal(titles.length,2);
 await runAction('monitor',store,secrets,fetcher,start+1200);assert.match(titles.at(-1)!,/offline/);
 outage=false;await runAction('monitor',store,secrets,fetcher,start+1500);assert.match(titles.at(-1)!,/recovered/);
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

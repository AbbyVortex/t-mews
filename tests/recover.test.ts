import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LocalD1, type Snapshot} from '../src/actions/sqlite';
import {runAction, type Store} from '../src/actions/run';

const target = 'x:2098612714704891959';
const baselineAt = 1788855495;
const now = 1789190436;
const secrets = {user:'u'.repeat(30),token:'t'.repeat(30)};
const baseline = JSON.parse(readFileSync(new URL('./fixtures/tibo-baseline-89.json',import.meta.url),'utf8')).posts;
const recent = JSON.parse(readFileSync(new URL('./fixtures/tibo-new-posts-2026-09-12.json',import.meta.url),'utf8')).posts;

function setup() {
 const db = new LocalD1();
 for (const [items,isBaseline] of [[baseline,1],[recent,0]] as const) {
  for (const p of items) db.sqlite.prepare('INSERT INTO posts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
   p.id,p.id.slice(2),p.url,`fixture:${p.id}`,p.publishedAt,isBaseline?baselineAt:p.publishedAt+378,
   p.text,'fxtwitter','post',p.originalClassification,'previous classifier reason',isBaseline,0,
   isBaseline?'baseline':'not_relevant',isBaseline?baselineAt-p.publishedAt:378);
 }
 for (const [key,value] of Object.entries({baselineAt,lastSuccess:now-300,lastCleanup:now-3600,actionsEndAt:1789287495}))
  db.sqlite.prepare('INSERT INTO state VALUES(?,?)').run(key,JSON.stringify(value));
 for (const id of ['test','online']) db.sqlite.prepare('INSERT INTO notifications VALUES(?,?,?, ?,?,?)')
  .run(id,null,id,baselineAt,'sent',baselineAt);
 let saved:Snapshot = db.snapshot(); db.close();
 const messages:URLSearchParams[]=[];
 let failCheckpoint=false,loseResponse=false;
 const store:Store={
  load:async(init=false)=>{assert.equal(init,false,'recovery must never initialize state');return structuredClone(saved);},
  save:async next=>{
   if(failCheckpoint&&next.tables.notifications.some(n=>n.id===`post:${target}`&&n.status==='sending'))throw new Error('durable save unavailable');
   saved=structuredClone(next);
  }
 };
 const fetcher=(async(input:any,init:any)=>{
  assert.equal(String(input),'https://api.pushover.net/1/messages.json','recovery must never poll RSS');
  assert.equal(saved.tables.notifications.find(n=>n.id===`post:${target}`)?.status,'sending','claim must be durable before delivery');
  assert.equal(saved.tables.posts.find(p=>p.id===target)?.classification,'RESET_ANNOUNCED');
  messages.push(new URLSearchParams(init.body));
  if(loseResponse)throw new Error('response lost');
  return Response.json({status:1});
 }) as typeof fetch;
 return {store,fetcher,messages,snapshot:()=>structuredClone(saved),edit:(fn:(s:Snapshot)=>void)=>fn(saved),
  failCheckpoint:()=>failCheckpoint=true,loseResponse:()=>loseResponse=true};
}

test('recover one missed announcement once; preserve all other 105 rows, baseline and previous ledger',async()=>{
 const h=setup(), before=h.snapshot();
 assert.equal(before.tables.posts.length,106);
 assert.deepEqual(await runAction('recover',h.store,secrets,h.fetcher,now,target),{mode:'recover',postId:target,status:'sent'});
 assert.deepEqual(await runAction('recover',h.store,secrets,h.fetcher,now+60,target),{mode:'recover',postId:target,status:'already_sent'});
 assert.equal(h.messages.length,1);
 const after=h.snapshot(), row=after.tables.posts.find(p=>p.id===target)!;
 assert.deepEqual(after.tables.posts.filter(p=>p.id!==target),before.tables.posts.filter(p=>p.id!==target));
 assert.deepEqual(after.tables.state,before.tables.state);
 assert.deepEqual(after.tables.source_health,before.tables.source_health);
 assert.deepEqual(after.tables.notifications.filter(n=>n.post_id!==target),before.tables.notifications);
 assert.equal(row.classification,'RESET_ANNOUNCED');assert.equal(row.notified,1);assert.equal(row.notification_status,'sent');
 assert.equal(row.detection_latency_seconds,378);assert.equal(row.published_at,1789183236);
 assert.equal(after.tables.notifications.find(n=>n.post_id===target)?.sent_at,now);
 assert.equal(after.tables.events.filter(e=>e.id===`recovery:${target}`).length,1);
 const message=h.messages[0];
 assert.equal(message.get('priority'),'1');assert.equal(message.get('url'),row.canonical_url);
 assert.match(message.get('message')!,/分類修正により遅れて/);
 assert.match(message.get('message')!,/投稿から120分後/);
 assert.match(message.get('message')!,/検知遅延: 6分18秒/);
 assert.match(message.get('message')!,/a reset is also landing by midnight today/);
 assert.ok([...message.get('message')!].length<=1024,'long update must retain the final reset timing within the API limit');
});

test('recovery refuses old/baseline/repost/irrelevant/invalid rows without changing saved observations',async()=>{
 const cases:{name:string;edit:(s:Snapshot,p:Record<string,any>)=>void;id?:string}[]=[
  {name:'missing ID',edit:()=>{},id:''},
  {name:'unknown ID',edit:()=>{},id:'x:99999999'},
  {name:'baseline',edit:(_s,p)=>p.baseline=1},
  {name:'already notified',edit:(_s,p)=>p.notified=1},
  {name:'pending',edit:(_s,p)=>p.notification_status='pending'},
  {name:'already relevant',edit:(_s,p)=>p.classification='RESET_HINT'},
  {name:'repost',edit:(_s,p)=>p.kind='repost'},
  {name:'old post',edit:(_s,p)=>p.published_at=now-86401},
  {name:'future post',edit:(_s,p)=>p.published_at=now+1},
  {name:'undated post',edit:(_s,p)=>p.published_at=null},
  {name:'before baseline',edit:(_s,p)=>p.published_at=baselineAt-1},
  {name:'wrong author URL',edit:(_s,p)=>p.canonical_url=p.canonical_url.replace('thsottiaux','other')},
  {name:'weak hint',edit:(_s,p)=>p.text='when I say excellent service for existing users, that includes the occasional reset'},
  {name:'missing baseline',edit:s=>s.tables.state=s.tables.state.filter(r=>r.key!=='baselineAt')},
  {name:'unconfirmed test',edit:s=>s.tables.notifications.find(n=>n.id==='test')!.status='unknown'}
 ];
 for(const c of cases) {
  const h=setup();h.edit(s=>c.edit(s,s.tables.posts.find(p=>p.id===target)!));const before=h.snapshot();
  await assert.rejects(runAction('recover',h.store,secrets,h.fetcher,now,c.id??target),{name:'Error'},c.name);
  assert.equal(h.messages.length,0,c.name);assert.deepEqual(h.snapshot(),before,c.name);
 }
});

test('every prior delivery claim prevents recovery, including alternate ledger IDs',async()=>{
 for(const status of ['sending','unknown','failed','sent']) {
  const h=setup();h.edit(s=>{
   s.tables.notifications.push({id:'other-ledger-id',post_id:target,kind:'alert',created_at:now-60,status,sent_at:status==='sent'?now-60:null});
   s.tables.notifications.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  });
  const before=h.snapshot();
  if(status==='sent')assert.deepEqual(await runAction('recover',h.store,secrets,h.fetcher,now,target),{mode:'recover',postId:target,status:'already_sent'});
  else await assert.rejects(runAction('recover',h.store,secrets,h.fetcher,now,target),/refusing to resend/);
  assert.equal(h.messages.length,0);assert.deepEqual(h.snapshot(),before);
 }
});

test('failed durable checkpoint prevents delivery and a lost response never retries',async()=>{
 const blocked=setup();blocked.failCheckpoint();
 await assert.rejects(runAction('recover',blocked.store,secrets,blocked.fetcher,now,target));
 assert.equal(blocked.messages.length,0);
 await assert.rejects(runAction('recover',blocked.store,secrets,blocked.fetcher,now+60,target));
 assert.equal(blocked.messages.length,0);
 const uncertain=setup();uncertain.loseResponse();
 await assert.rejects(runAction('recover',uncertain.store,secrets,uncertain.fetcher,now,target));
 assert.equal(uncertain.messages.length,1);
 await assert.rejects(runAction('recover',uncertain.store,secrets,uncertain.fetcher,now+60,target));
 assert.equal(uncertain.messages.length,1);
 assert.equal(uncertain.snapshot().tables.notifications.find(n=>n.post_id===target)?.status,'unknown');
});

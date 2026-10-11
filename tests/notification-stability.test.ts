import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {runAction,type Store} from '../src/actions/run';
import type {Snapshot} from '../src/actions/sqlite';
import {fetchSource,parseFeed} from '../src/sources';
const start=1791700000;
const secrets={user:'u'.repeat(30),token:'t'.repeat(30)};
const source={name:'fx',url:'https://example.com/rss'};
const empty='<rss><channel><title>Tibo (@thsottiaux)</title><link>https://x.com/thsottiaux</link></channel></rss>';
const xml=(id='1',text='Ordinary update',at=start-60)=>empty.replace('</channel>',`<item><link>https://x.com/thsottiaux/status/${id}</link><description>${text}</description><pubDate>${new Date(at*1000).toUTCString()}</pubDate></item></channel>`);
function skipBackoff(t:TestContext) {
 t.mock.method(globalThis,'setTimeout',((callback:()=>void,ms:number)=>{assert.equal(ms,2000);queueMicrotask(callback);return 0;}) as any);
}
async function harness(t:TestContext) {
 skipBackoff(t);
 let saved:Snapshot|undefined,body=xml(),code=200;
 const messages:string[]=[];
 const store:Store={load:async()=>structuredClone(saved),save:async s=>{saved=structuredClone(s);}};
 const fetcher=(async(input:any,init:any)=>{
  if(String(input).includes('pushover')) {messages.push(new URLSearchParams(init.body).get('title')!);return Response.json({status:1});}
  return new Response(body,{status:code});
 }) as typeof fetch;
 const run=(elapsed:number)=>runAction('monitor',store,secrets,fetcher,start+elapsed);
 await runAction('test',store,secrets,fetcher,start);await run(0);
 return {run,messages,state:()=>saved!,set:(status:number,text=xml())=>{code=status;body=text;}};
}
test('short 404/success oscillation is silent and unchanged feeds remain successful',async t=>{
 const h=await harness(t),before=structuredClone(h.state());
 for(const n of [600,1800,3000]){h.set(404);await h.run(n);h.set(200);await h.run(n+600);}
 assert.equal(h.messages.length,2);
 assert.deepEqual(h.state().tables.notifications,before.tables.notifications);
 assert.equal(h.state().publicStatus?.lastRssSuccessAt,start+3600);
 assert.deepEqual(h.state().tables.posts,before.tables.posts);
});
test('long outage stays one episode through flapping; recovery waits ten minutes but important posts do not',async t=>{
 const h=await harness(t),before=structuredClone(h.state());
 h.set(404);await h.run(300);await h.run(1199);assert.equal(h.messages.length,2);
 await h.run(1200);assert.match(h.messages.at(-1)!,/offline/);
 h.set(200,xml('2','We will reset the usage limits tomorrow.',start+1400));await h.run(1500);
 assert.equal(h.messages.length,4);assert.match(h.messages.at(-1)!,/リセット予告/);
 assert.equal(h.state().tables.state.some(r=>r.key==='outage'),true);
 h.set(404);await h.run(1800);await h.run(3000);
 assert.equal(h.messages.length,4,'same episode must not emit another offline');
 h.set(200,xml('2','We will reset the usage limits tomorrow.',start+1400));
 await h.run(3300);await h.run(3600);assert.equal(h.messages.length,4);
 await h.run(3900);await h.run(4500);
 assert.equal(h.messages.length,5);assert.match(h.messages.at(-1)!,/recovered/);
 assert.equal(h.state().tables.state.some(r=>['outage','recoverySince'].includes(r.key)),false);
 for(const row of before.tables.notifications)assert.deepEqual(h.state().tables.notifications.find(n=>n.id===row.id),row);
 assert.deepEqual(h.state().tables.state.find(r=>r.key==='baselineAt'),before.tables.state.find(r=>r.key==='baselineAt'));
 assert.equal(h.state().tables.notifications.filter(n=>n.id==='post:x:2').length,1);
 // A later genuine outage is a new episode, with its own single notification.
 h.set(503);await h.run(5100);await h.run(6300);
 assert.equal(h.messages.filter(x=>x.includes('offline')).length,2);
});
test('invalid responses preserve last success and data; authenticated-by-content empty feed is success',async t=>{
 const h=await harness(t),before=structuredClone(h.state());
 for(const body of ['<html>challenge</html>','<rss>','<rss><channel><title>Service unavailable</title></channel></rss>',xml().replaceAll('/thsottiaux/status/','/someoneelse/status/')]) {
  h.set(200,body);await h.run(600);
  assert.equal(h.state().publicStatus?.lastRssSuccessAt,start);
  assert.equal(h.state().publicStatus?.sourceState,'offline');
  assert.deepEqual(h.state().tables.posts,before.tables.posts);
  assert.deepEqual(h.state().tables.notifications,before.tables.notifications);
 }
 h.set(200,empty);await h.run(1200);
 assert.equal(h.state().publicStatus?.lastRssSuccessAt,start+1200);
 assert.equal(h.state().publicStatus?.sourceState,'online');
 assert.deepEqual(h.state().tables.posts,before.tables.posts);
 assert.deepEqual(h.state().tables.notifications,before.tables.notifications);
});
test('empty feed requires target identity and does not establish an empty initial baseline',async t=>{
 skipBackoff(t);
 assert.deepEqual(await parseFeed(empty,source),[]);
 await assert.rejects(parseFeed(empty.replace('https://x.com/thsottiaux','https://example.com/thsottiaux'),source));
 await assert.rejects(parseFeed(empty.replace('Tibo (@thsottiaux)','Service unavailable'),source));
 let saved:Snapshot|undefined;
 const store:Store={load:async()=>saved,save:async s=>{saved=structuredClone(s);}};
 const fetcher=(async(input:any)=>String(input).includes('pushover')?Response.json({status:1}):new Response(empty)) as typeof fetch;
 await runAction('test',store,secrets,fetcher,start);await runAction('monitor',store,secrets,fetcher,start);
 assert.equal(saved!.tables.state.some(r=>r.key==='baselineAt'),false);
 assert.equal(saved!.tables.notifications.length,1);
});
test('transient HTTP and network errors get one bounded retry; permanent errors do not',async t=>{
 skipBackoff(t);
 for(const status of [404,408,500,502,503]) {
  let calls=0;
  assert.equal((await fetchSource(source,async()=>++calls===1?new Response('',{status}):new Response(xml()))).length,1);
  assert.equal(calls,2);
 }
 let calls=0;
 await assert.rejects(fetchSource(source,async()=>{calls++;throw new TypeError('network');}));assert.equal(calls,2);
 for(const status of [400,401,403,429]) {
  calls=0;await assert.rejects(fetchSource(source,async()=>{calls++;return new Response('',{status});}));assert.equal(calls,1);
 }
 calls=0;await assert.rejects(fetchSource(source,async()=>{calls++;return new Response('<html>invalid</html>');}));assert.equal(calls,1);
});

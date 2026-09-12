import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runAction,type Store} from '../src/actions/run';
import type {Snapshot} from '../src/actions/sqlite';
import {classify} from '../src/classifier';
import {alertMessage,alertTitle} from '../src/pushover';
import type {Item} from '../src/types';

const start=Date.parse('2026-09-12T06:00:00Z')/1000;
const credentials={user:'u'.repeat(30),token:'t'.repeat(30)};
const entry=(id:string,text:string,time=start+60,extra='')=>`<item><title>${text.startsWith('@')?'Replying to user':'Post'}</title><link>https://x.com/thsottiaux/status/${id}</link><pubDate>${new Date(time*1000).toUTCString()}</pubDate>${extra}<description><![CDATA[${text}]]></description></item>`;
const feed=(...items:string[])=>`<rss xmlns:th="http://purl.org/syndication/thread/1.0"><channel><title>Tibo @thsottiaux</title>${items.join('')}</channel></rss>`;
async function setup() {
 let saved:Snapshot|undefined,xml=feed(entry('1','We will reset usage tomorrow.',start-60));
 const messages:URLSearchParams[]=[];
 const store:Store={load:async()=>structuredClone(saved),save:async state=>{saved=structuredClone(state);}};
 const fetcher=(async(input:any,init:any)=>{
  if(String(input).includes('pushover.net')) {
   assert.ok(saved?.tables.notifications.some(n=>n.status==='sending'));
   messages.push(new URLSearchParams(init.body));return Response.json({status:1});
  }
  assert.match(String(input),/with_replies=true/);return new Response(xml);
 }) as typeof fetch;
 await runAction('test',store,credentials,fetcher,start);
 await runAction('monitor',store,credentials,fetcher,start);
 messages.length=0;
 return {store,fetcher,messages,read:()=>structuredClone(saved!),edit:(f:(s:Snapshot)=>void)=>f(saved!),
  feed:(...items:string[])=>xml=feed(...items),run:(time=start+300)=>runAction('monitor',store,credentials,fetcher,time)};
}

test('reply-feed cutover baselines newly visible history once and preserves old rows and delivery ledger',async()=>{
 const h=await setup();h.edit(s=>s.tables.state=s.tables.state.filter(r=>r.key!=='fxtwitter-with-replies-v1'));
 const before=h.read();
 h.feed(entry('1','We will reset usage tomorrow.',start-60),entry('2','@user the occasional reset',start+10));
 await h.run();await h.run(start+600);
 assert.equal(h.messages.length,0);
 const after=h.read();
 assert.deepEqual(after.tables.posts.find(p=>p.id==='x:1'),before.tables.posts[0]);
 assert.deepEqual(after.tables.notifications,before.tables.notifications);
 assert.equal(after.tables.posts.find(p=>p.id==='x:2')?.baseline,1);
 assert.ok(after.tables.state.some(r=>r.key==='fxtwitter-with-replies-v1'));
 h.feed(entry('3','@user the occasional reset',start+601));await h.run(start+900);await h.run(start+1200);
 assert.equal(h.messages.length,1);assert.equal(h.messages[0].get('title'),'🍄注意報');
 h.feed(entry('4','A late older reset reply',start+100));await h.run(start+1500);
 assert.equal(h.messages.length,1,'a late pre-cutover reply is also baseline');
 assert.equal(h.read().tables.posts.find(p=>p.id==='x:4')?.baseline,1);
});

test('explicit parent ID resolves saved text; emoji reply is one advisory without changing the parent',async()=>{
 const h=await setup(),before=h.read().tables.posts[0];
 h.feed(entry('2','👀',start+60,'<th:in-reply-to href="https://x.com/i/status/1"/>'));
 await h.run();await h.run(start+600);
 assert.equal(h.messages.length,1);assert.equal(h.messages[0].get('title'),'🍄注意報');
 assert.equal(h.messages[0].get('priority'),'0');
 assert.match(h.messages[0].get('message')!,/本人: 👀/);
 assert.match(h.messages[0].get('message')!,/返信先（@thsottiaux）/);
 assert.deepEqual(h.read().tables.posts.find(p=>p.id==='x:1'),before);
 const analysis=JSON.parse(h.read().tables.events.find(e=>e.id==='analysis:x:2')!.details);
 assert.equal(analysis.related[0].provenance,'saved');assert.equal(analysis.verdict.display,'advisory');
 h.feed(entry('3','👀',start+601,'<th:in-reply-to href="https://x.com/other/status/999"/>'));
 await h.run(start+900);assert.equal(h.messages.length,1,'unknown parent is not guessed');
 h.feed(entry('4','@user Reset!',start+901));await h.run(start+1200);
 assert.equal(h.messages.length,2,'own reset does not depend on fetching the parent');
});

test('quote, separate correction, postponement and cancellation each notify once without upgrading the quote',async()=>{
 const h=await setup();
 h.feed(entry('2','👀<blockquote><a href="https://x.com/other/status/200">Reset all usage tomorrow.</a></blockquote>'));
 await h.run();
 h.feed(entry('3','Correction: the reset is at 7pm UTC tomorrow.',start+301));await h.run(start+600);
 h.feed(entry('4','The reset is postponed until tomorrow.',start+601));await h.run(start+900);
 h.feed(entry('5','We cancelled the reset.',start+901));await h.run(start+1200);await h.run(start+1500);
 assert.equal(h.messages.length,4);
 assert.equal(h.messages[0].get('title'),'🍄注意報');
 assert.match(h.messages[1].get('title')!,/訂正/);assert.match(h.messages[2].get('title')!,/延期/);assert.match(h.messages[3].get('title')!,/取消/);
 assert.ok(h.messages.every(m=>m.get('priority')==='0'));
});

test('long engineering text preserves the reset passage, time conversion and original link',()=>{
 const relevant='Correction: the reset will land at 6pm PDT tomorrow.';
 const text='Engineering detail. '.repeat(160)+relevant+' More engineering detail.'.repeat(160);
 const item:Item={id:'x:99',xStatusId:'99',url:'https://x.com/thsottiaux/status/99',fingerprint:'test',text,publishedAt:start,source:'fx',kind:'post'};
 const verdict=classify(text),message=alertMessage(item,verdict.classification,120,'',verdict);
 assert.match(alertTitle(verdict),/訂正/);assert.match(message,/Correction: the reset will land at 6pm PDT tomorrow/);
 assert.match(message,/2026\/09\/13 10:00 JST/);assert.match(message,/投稿時刻:/);
 assert.ok([...message].length<=1024);
});

test('failed or absent time parsing never prevents a reset notification',()=>{
 for(const text of ['Reset is coming.','Reset by midnight today.','The reset will land at 99:99 UTC tomorrow.']) {
  const item:Item={id:'x:99',xStatusId:'99',url:'https://x.com/thsottiaux/status/99',fingerprint:'test',text,publishedAt:start,source:'fx',kind:'post'};
  const verdict=classify(text);assert.equal(verdict.notify,true);
  assert.ok(alertMessage(item,verdict.classification,120,'',verdict).includes(text));
 }
});

test('notification preserves both release and claim JST times before long author evidence',()=>{
 const text=`The banked reset will land ${'for all eligible paid subscribers '.repeat(12)}at 6pm UTC today. Claim it ${'using the account settings page '.repeat(12)}before 8pm UTC tomorrow.`;
 const item:Item={id:'x:98',xStatusId:'98',url:'https://x.com/thsottiaux/status/98',fingerprint:'test',text,publishedAt:start,source:'fx',kind:'post'};
 const verdict=classify(text),message=alertMessage(item,verdict.classification,120,'Recovery note. '.repeat(20),verdict);
 assert.match(message,/リセット予定（日本時間）: 2026\/09\/13 03:00 JST/);
 assert.match(message,/リセット期限（日本時間）: 2026\/09\/14 05:00 JST/);
 assert.match(message,/6pm UTC today/);assert.match(message,/8pm UTC tomorrow/);
 assert.ok(message.indexOf('2026/09/14 05:00 JST')<message.indexOf('本人:'));
 assert.ok([...message].length<=1024);
});

test('notification keeps a clock buried in the middle of a long reset clause',()=>{
 const text=`A reset will land ${'for paid subscriptions '.repeat(15)}at 7:30pm PDT tomorrow ${'with continued access to the service '.repeat(15)}.`;
 const item:Item={id:'x:97',xStatusId:'97',url:'https://x.com/thsottiaux/status/97',fingerprint:'test',text,publishedAt:start,source:'fx',kind:'post'};
 const verdict=classify(text),message=alertMessage(item,verdict.classification,120,'',verdict);
 assert.match(message,/2026\/09\/13 11:30 JST/);
 assert.match(message,/7:30pm PDT tomorrow/);
 assert.ok(message.indexOf('7:30pm PDT tomorrow')<message.indexOf('本人:'));
 assert.ok([...message].length<=1024);
});

test('compact timing retains parent attribution and the author own clock separately',()=>{
 const item:Item={id:'x:96',xStatusId:'96',url:'https://x.com/thsottiaux/status/96',fingerprint:'test',text:'Landing at 8pm today.',publishedAt:start,source:'fx',kind:'reply',
  related:[{relation:'reply',xStatusId:'95',url:'https://x.com/other/status/95',author:'other',text:'A reset will land at 6pm PT tomorrow.',publishedAt:start-60,provenance:'feed'}]};
 const verdict=classify(item.text,item.related),message=alertMessage(item,verdict.classification,120,'',verdict);
 assert.match(message,/2026\/09\/12 12:00 JST/);
 assert.match(message,/原文・本人の記述.*8pm today/);
 assert.match(message,/返信先 https:\/\/x\.com\/other\/status\/95/);
 assert.match(message,/時区を参照: PT/);
 assert.match(message,/本人: Landing at 8pm today/);
 assert.match(message,/返信先（@other）: A reset will land at 6pm PT tomorrow/);
 assert.ok([...message].length<=1024);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { classify } from '../src/classifier';
import { parseFeed } from '../src/sources';
import { monitor } from '../src/monitor';
import worker,{status} from '../src/index';
import type { Env, Fetcher } from '../src/types';
const start=Date.parse('2026-09-08T06:00:00Z')/1000;
function feed(id:string,text:string,time=start+60,host='x.com') {return `<?xml version="1.0"?><rss version="2.0"><channel><title>Tibo (@thsottiaux)</title><item><title><![CDATA[${text}]]></title><link>https://${host}/thsottiaux/status/${id}</link><pubDate>${new Date(time*1000).toUTCString()}</pubDate><description><![CDATA[<p>${text}</p>]]></description></item></channel></rss>`;}
async function setup() {
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],compatibilityDate:'2026-07-30'});
 const db=await mf.getD1Database('DB');
 for(const sql of readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8').split(';').map(x=>x.trim()).filter(Boolean)) await db.prepare(sql).run();
 const env:Env={DB:db as unknown as D1Database,MONITOR_ENABLED:'true',SOURCES_JSON:JSON.stringify([{name:'fx',url:'https://example.com/rss'}]),PUSHOVER_APP_TOKEN:'test-placeholder',PUSHOVER_USER_KEY:'test-placeholder'};
 let xml=feed('1','Ordinary Codex performance',start-60),fail=false,pushFail=false;
 const messages:URLSearchParams[]=[];
 const fetcher=(async(input:any,init:any)=>{if(String(input).includes('pushover.net')) {messages.push(new URLSearchParams(init.body));if(pushFail)throw new Error('timeout');return Response.json({status:1});}if(fail)return new Response('Unavailable',{status:503});return new Response(xml);}) as Fetcher;
 return {env,mf,fetcher,messages,setXml:(v:string)=>xml=v,setFail:(v:boolean)=>fail=v,setPushFail:()=>pushFail=true};
}
test('A–D: deterministic classifier and negative controls',()=>{
 for(const [text,expected] of [
  ["Who says it won't reset in a while 👀",'RESET_HINT'],
  ['Five million users would agree. Resetting the limits tomorrow morning to celebrate. Time to go /fast','RESET_ANNOUNCED'],
  ['We are giving all paid Codex subscribers a Banked Reset. Claim it before Friday.','BANKED_RESET'],
  ['Astra performs better on GPU benchmarks in Codex. 👀','IRRELEVANT'],
  ['I’ll reset the usage limits tomorrow.','RESET_ANNOUNCED'],
  ['We will do a global reset of the usage for all paid subscriptions. Lands around 6pm PST today.','RESET_ANNOUNCED'],
  ['All reset for everyone. Enjoy the week with Astra.','RESET_ANNOUNCED'],
  ['Codex weekly allowance has doubled.','LIMIT_CHANGE'],
  ['ChatGPT now draws 3-4X less usage from the subscription.','LIMIT_CHANGE'],
  ['Codex can reset the git branch and reduce memory usage.','CANDIDATE'],
  ['We will not reset usage limits tomorrow.','CANDIDATE'],
  ['Codex usage reset behavior is documented here.','CANDIDATE']
  ,['Codex weekly benchmarks show more throughput.','IRRELEVANT']
  ,['Usage limits will reset at 6pm tomorrow.','RESET_ANNOUNCED']
 ]) {const v=classify(text);assert.equal(v.classification,expected,text);assert.equal(v.notify,expected!=='IRRELEVANT');}
});
test('RSS, Atom, entities, quote isolation, wrong author and malformed feeds',async()=>{
 const [p]=await parseFeed(feed('20',"Who says it won&apos;t reset in a while 👀<blockquote>irrelevant quote</blockquote>"),{name:'fx',url:'https://example.com'});
 assert.equal(p.text,"Who says it won't reset in a while 👀");assert.equal(p.xStatusId,'20');
 const atom='<feed xmlns="http://www.w3.org/2005/Atom"><title>Tibo @thsottiaux</title><entry><id>tag:test</id><link href="https://nitter.net/thsottiaux/status/20"/><content type="html">Hi &amp;amp; hello</content><published>2026-09-08T06:00:00Z</published></entry></feed>';
 assert.equal((await parseFeed(atom,{name:'atom',url:'https://example.com'}))[0].url,p.url);
 await assert.rejects(parseFeed('<html>challenge</html>',{name:'bad',url:'https://example.com'}));
 await assert.rejects(parseFeed(feed('20','test').replaceAll('/thsottiaux/','/someoneelse/'),{name:'bad',url:'https://example.com'}));
});
test('E, G: baseline, cross-source dedup, no repeated writes on unchanged poll, public export',async()=>{
 const h=await setup();try {
  h.setXml(feed('1','Resetting the limits tomorrow morning.',start-100));await monitor(h.env,start,h.fetcher);
  assert.equal(h.messages.length,1);assert.match(h.messages[0].get('title')! ,/online/);
  h.setXml(feed('2',"Who says it won't reset in a while 👀"));await monitor(h.env,start+90,h.fetcher);
  h.env.SOURCES_JSON=JSON.stringify([{name:'nitter',url:'https://example.org/rss'}]);h.setXml(feed('2',"Who says it won't reset in a while 👀",start+60,'nitter.net'));
  await monitor(h.env,start+120,h.fetcher);await monitor(h.env,start+180,h.fetcher);
  assert.equal(h.messages.length,2);
  assert.equal((await h.env.DB.prepare('SELECT COUNT(*) AS n FROM posts').first<any>()).n,2);
  const snapshot=await status(h.env,start+180);assert.equal(snapshot.alerts,1);assert.equal(snapshot.latency.max,30);
  const page=await worker.fetch(new Request('https://local/'),h.env);assert.equal(page.status,200);assert.ok(!(await page.text()).includes('test-placeholder'));
 }finally{await h.mf.dispose();}
});
test('F: short errors silent, 15-minute offline once, recovered once',async()=>{
 const h=await setup();try {
  await monitor(h.env,start,h.fetcher);h.setFail(true);
  for(const elapsed of [60,120,899,959]) await monitor(h.env,start+elapsed,h.fetcher);
  assert.equal(h.messages.length,1);
  await monitor(h.env,start+960,h.fetcher);await monitor(h.env,start+1020,h.fetcher);
  assert.equal(h.messages.length,2);assert.match(h.messages[1].get('title')!,/offline/);
  h.setFail(false);await monitor(h.env,start+1080,h.fetcher);await monitor(h.env,start+1140,h.fetcher);
  assert.equal(h.messages.length,3);assert.match(h.messages[2].get('title')!,/recovered/);
 }finally{await h.mf.dispose();}
});
test('fallback hides primary outage, ambiguous push never retries, pause prevents fetch',async()=>{
 const h=await setup();try {
  h.env.SOURCES_JSON=JSON.stringify([{name:'bad',url:'https://bad.example/rss'},{name:'fx',url:'https://example.com/rss'}]);
  const fetcher=(async(input:any,init:any)=>String(input).includes('bad.example')?new Response('no',{status:503}):h.fetcher(input,init)) as Fetcher;
  await monitor(h.env,start,fetcher);h.setXml(feed('3','Resetting the limits tomorrow.'));h.setPushFail();
  await monitor(h.env,start+120,fetcher);await monitor(h.env,start+180,fetcher);
  assert.equal(h.messages.length,2);assert.equal((await status(h.env,start+180)).uncertainNotifications,1);
  h.env.MONITOR_ENABLED='false';await monitor(h.env,start+240,async()=>{throw new Error('must not fetch')});
 }finally{await h.mf.dispose();}
});
test('concurrent jobs send each new alert once',async()=>{
 const h=await setup();try {
  await monitor(h.env,start,h.fetcher);h.setXml(feed('9','Resetting the usage limits tomorrow.'));
  await Promise.all([monitor(h.env,start+120,h.fetcher),monitor(h.env,start+120,h.fetcher)]);
  assert.equal(h.messages.length,2);assert.equal((await h.env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE id='x:9'").first<any>()).n,1);
 }finally{await h.mf.dispose();}
});
test('fallback text hash dedup and late historical arrival suppression',async()=>{
 const h=await setup();try {
  await monitor(h.env,start,h.fetcher);
  const original=feed('10','Codex usage limits may reset.',start+60);
  h.setXml(original.replace('https://x.com/thsottiaux/status/10','https://example.com/item'));
  await monitor(h.env,start+120,h.fetcher);h.setXml(original);await monitor(h.env,start+180,h.fetcher);
  assert.equal((await h.env.DB.prepare('SELECT COUNT(*) n FROM posts').first<any>()).n,2);
  h.setXml(feed('11','Resetting the limits tomorrow.',start-3600));await monitor(h.env,start+240,h.fetcher);
  assert.equal(h.messages.length,2);
 }finally{await h.mf.dispose();}
});

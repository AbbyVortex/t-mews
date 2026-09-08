import {LocalD1,type Snapshot} from './sqlite';
import {monitor} from '../monitor';
import {notify} from '../pushover';
import {fetchSource} from '../sources';
import type {Env,Fetcher} from '../types';
export interface Store {load(initialize?:boolean):Promise<Snapshot|undefined>;save(snapshot:Snapshot):Promise<void>}
export async function runAction(mode:'test'|'monitor'|'check',store:Store,secrets:{user:string,token:string},fetcher:Fetcher=fetch,now=Math.floor(Date.now()/1000)) {
 if(mode==='check') {
  const items=await fetchSource({name:'fxtwitter',url:'https://fxtwitter.com/thsottiaux/feed.xml'},fetcher);
  return {source:'fxtwitter',items:items.length};
 }
 const db=new LocalD1(await store.load(mode==='test'));
 const env:Env={DB:db.asD1(),MONITOR_ENABLED:'true',SOURCES_JSON:JSON.stringify([{name:'fxtwitter',url:'https://fxtwitter.com/thsottiaux/feed.xml'}]),PUSHOVER_USER_KEY:secrets.user,PUSHOVER_APP_TOKEN:secrets.token};
 // A durable pre-send claim must be acknowledged before making the irreversible request.
 const safeFetch=(async(input:any,init:any)=>{
  if(String(input)==='https://api.pushover.net/1/messages.json') {
   await store.save(db.snapshot());
  }
  return fetcher(input,init);
 }) as Fetcher;
 try {
  if(!/^[A-Za-z0-9]{30}$/.test(secrets.user)||!/^[A-Za-z0-9]{30}$/.test(secrets.token))throw new Error('Both Pushover Actions Secrets must be configured');
  if(mode==='test') {
   await notify(env,'test','test','🍄 T-MEWS: 接続テスト','GitHub Actions版T-MEWSの接続テストです。このテスト通知は1回だけ送信します。',now,safeFetch);
   const test=await db.prepare("SELECT status FROM notifications WHERE id='test'").first<any>();
   if(test?.status!=='sent')throw new Error('Test delivery failed or uncertain; no automatic resend');
  }else {
   const test=await db.prepare("SELECT status FROM notifications WHERE id='test'").first<any>();
   if(test?.status!=='sent')throw new Error('A successful one-time Pushover test is required before monitoring');
   // Primary Actions operation has no expiry. Preserve any legacy actionsEndAt as history.
   await monitor(env,now,safeFetch);
  }
  return {mode,posts:(await db.prepare('SELECT COUNT(*) n FROM posts').first<any>())?.n,notifications:(await db.prepare("SELECT COUNT(*) n FROM notifications WHERE status='sent'").first<any>())?.n};
 }finally {
  try {await store.save(db.snapshot());}finally{db.close();}
 }
}

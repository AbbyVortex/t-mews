import type { Env, Fetcher, Item } from './types';
import { sources, fetchSource } from './sources';
import { classify } from './classifier';
import { notify, alertTitle, alertMessage } from './pushover';
import {resolveRelated,saveAnalysis,readAnalysis} from './post-analysis';
const put = (db:D1Database,key:string,value:unknown) => db.prepare('INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,JSON.stringify(value));
export async function readState(db:D1Database): Promise<Record<string,any>> { const r=await db.prepare('SELECT * FROM state').all<{key:string,value:string}>();return Object.fromEntries(r.results.map(r=>[r.key,JSON.parse(r.value)])); }
export async function monitor(env: Env, now=Math.floor(Date.now()/1000), fetcher: Fetcher=fetch) {
 if(env.MONITOR_ENABLED!=='true' || (env.EXPERIMENT_END_AT && Date.parse(env.EXPERIMENT_END_AT)<=now*1000)) return;
 if(!env.PUSHOVER_USER_KEY || !env.PUSHOVER_APP_TOKEN) throw new Error('pushover_secrets_missing');
 const state=await readState(env.DB);
 const health=await env.DB.prepare('SELECT * FROM source_health').all<any>();
 let items:Item[]|null=null,active:string|null=null;
 for(const source of sources(env.SOURCES_JSON)) {
  const old=health.results.find(h=>h.source===source.name);
  let error:string|null=null;
  try { items=await fetchSource(source,fetcher);active=source.name; } catch(e) { error=e instanceof Error && /^(http_\d+|unsafe_xml|invalid_xml|not_rss_or_atom|source_notice|empty_or_oversized_feed|no_tibo_items|empty_body|feed_too_large)$/.test(e.message)?e.message:'fetch_or_parse_failed'; }
  const next=error?'offline':'online';
  const last=error?old?.last_failure_at:old?.last_success_at;
  if(!old || old.state!==next || !last || now-last>=300) {
   await env.DB.prepare(`INSERT INTO source_health(source,state,last_success_at,last_failure_at,offline_since,failure_episodes,error) VALUES(?,?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET state=excluded.state,last_success_at=COALESCE(excluded.last_success_at,source_health.last_success_at),last_failure_at=COALESCE(excluded.last_failure_at,source_health.last_failure_at),offline_since=excluded.offline_since,failure_episodes=excluded.failure_episodes,error=excluded.error`).bind(source.name,next,error?null:now,error?now:null,error?(old?.offline_since??now):null,(old?.failure_episodes??0)+(error&&old?.state!=='offline'?1:0),error).run();
  }
  if(items) break;
 }
 if(!items) {
  const outage=state.outage??now;
  if(!state.outage) await put(env.DB,'outage',outage).run();
  if(now-outage>=900) await notify(env,`offline:${outage}`,'offline','📡 T-MEWS sensor offline','すべての利用可能なRSSソースが15分以上連続で取得に失敗しています。',now,fetcher);
  return;
 }
 if(state.outage) {
  const warning=await env.DB.prepare('SELECT status FROM notifications WHERE id=?').bind(`offline:${state.outage}`).first<{status:string}>();
  if(warning && ['sent','unknown','sending'].includes(warning.status)) await notify(env,`recovered:${state.outage}`,'recovered','📡 T-MEWS sensor recovered',`RSS取得が復旧しました。ソース: ${active}`,now,fetcher);
  await env.DB.prepare("DELETE FROM state WHERE key='outage'").run();
 }
 if(!state.lastSuccess || now-state.lastSuccess>=300 || state.activeSource!==active || state.outage) await env.DB.batch([put(env.DB,'lastSuccess',now),put(env.DB,'activeSource',active)]);
 const bootstrap=!state.baselineAt;
 const sourceBootstrap=Boolean(env.SOURCE_BASELINE_KEY&&!state[env.SOURCE_BASELINE_KEY]);
 const unique=await resolveRelated([...new Map(items.map(i=>[i.id,i])).values()],env.DB);
 const known=await env.DB.prepare('SELECT id,x_status_id,canonical_url,fingerprint FROM posts WHERE id IN (SELECT value FROM json_each(?)) OR canonical_url IN (SELECT value FROM json_each(?)) OR fingerprint IN (SELECT value FROM json_each(?))').bind(JSON.stringify(unique.map(i=>i.id)),JSON.stringify(unique.map(i=>i.url)),JSON.stringify(unique.map(i=>i.fingerprint))).all<any>();
 const writes:D1PreparedStatement[]=[];
 const newRows:unknown[][]=[];
 for(const post of unique) {
  const existing=known.results.find(r=>r.id===post.id || (post.xStatusId && r.x_status_id===post.xStatusId) || (post.url && r.canonical_url===post.url) || (r.fingerprint===post.fingerprint && (!r.x_status_id || !post.xStatusId)));
  if(existing) continue;
  const verdict=classify(post.text,post.related);
  const baselineAt=Math.max(state.baselineAt??0,env.SOURCE_BASELINE_KEY?state[env.SOURCE_BASELINE_KEY]??0:0);
  const historical=bootstrap || sourceBootstrap || (post.publishedAt!==null && (post.publishedAt<=baselineAt || post.publishedAt<now-14*86400));
  const latency=post.publishedAt===null || post.publishedAt>now+60 ? null : Math.max(0,now-post.publishedAt);
  const status=historical?'baseline':post.kind==='repost'?'suppressed_repost':verdict.notify?'pending':'not_relevant';
  newRows.push([post.id,post.xStatusId,post.url,post.fingerprint,post.publishedAt,now,post.text,post.source,post.kind,verdict.classification,verdict.reason,historical?1:0,0,status,latency]);
  if(post.related?.length||verdict.notify)writes.push(saveAnalysis(env.DB,post,verdict,now));
  known.results.push({id:post.id,x_status_id:post.xStatusId,canonical_url:post.url,fingerprint:post.fingerprint});
 }
 // Baseline rows and its marker commit in one D1 transaction.
 if(newRows.length) writes.push(env.DB.prepare(`INSERT OR IGNORE INTO posts SELECT ${Array.from({length:15},(_,i)=>`json_extract(value,'$[${i}]')`).join(',')} FROM json_each(?)`).bind(JSON.stringify(newRows)));
 if(bootstrap) writes.push(env.DB.prepare("INSERT OR IGNORE INTO state VALUES('baselineAt',?)").bind(JSON.stringify(now)));
 if(sourceBootstrap)writes.push(put(env.DB,env.SOURCE_BASELINE_KEY!,now));
 if(writes.length) await env.DB.batch(writes);
 const online=await env.DB.prepare("SELECT id FROM notifications WHERE id='online'").first();
 if(!online) await notify(env,'online','online','🍄 T-MEWS online',`T-MEWS is online and the baseline was established.\n基準データ: ${unique.length}件。過去投稿は通知しません。`,now,fetcher);
 const pending=await env.DB.prepare("SELECT p.* FROM posts p LEFT JOIN notifications n ON n.id='post:'||p.id WHERE p.notification_status='pending' AND n.id IS NULL ORDER BY p.detected_at LIMIT 5").all<any>();
 for(const row of pending.results) {
  const analysis=await readAnalysis(env.DB,row.id);
  const post:Item={id:row.id,xStatusId:row.x_status_id,url:row.canonical_url,fingerprint:row.fingerprint,text:row.text,publishedAt:row.published_at,source:row.source,kind:row.kind,related:analysis.related};
  const classification=row.classification as ReturnType<typeof classify>['classification'];
  const verdict=analysis.verdict??classify(post.text,post.related);
  await notify(env,`post:${post.id}`,'alert',alertTitle(verdict),alertMessage(post,classification,row.detection_latency_seconds,'',verdict),now,fetcher,post,verdict.display==='announcement'?classification:undefined);
 }
 if(!state.lastCleanup || now-state.lastCleanup>=86400) {
  const cutoff=now-14*86400;
  await env.DB.batch([env.DB.prepare('DELETE FROM posts WHERE detected_at<?').bind(cutoff),env.DB.prepare('DELETE FROM events WHERE created_at<?').bind(cutoff),put(env.DB,'lastCleanup',now)]);
 }
}

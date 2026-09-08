import type { Env } from './types';
import { monitor, readState } from './monitor';
import { jst } from './pushover';
const escape=(v:unknown)=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export async function status(env:Env,now=Math.floor(Date.now()/1000)) {
 const [s,health,posts,alerts,uncertain,total] = await Promise.all([
  readState(env.DB),env.DB.prepare('SELECT * FROM source_health').all<any>(),
  env.DB.prepare('SELECT MAX(published_at) AS latest,COUNT(*) AS retained,SUM(CASE WHEN baseline=0 THEN 1 ELSE 0 END) AS newPosts FROM posts').first<any>(),
  env.DB.prepare("SELECT MAX(sent_at) AS latest,COUNT(*) AS total FROM notifications WHERE status='sent' AND kind='alert'").first<any>(),
  env.DB.prepare("SELECT COUNT(*) AS total FROM notifications WHERE status IN ('unknown','sending','failed')").first<any>(),
  env.DB.prepare('SELECT detection_latency_seconds AS latency FROM posts WHERE baseline=0 AND detection_latency_seconds IS NOT NULL ORDER BY detection_latency_seconds').all<{latency:number}>()
 ]);
 const values=total.results.map(x=>x.latency),n=values.length;
 const paused=env.MONITOR_ENABLED!=='true'||Boolean(env.EXPERIMENT_END_AT&&Date.parse(env.EXPERIMENT_END_AT)<=now*1000);
 return {state:paused?'paused':!s.baselineAt?'initializing':s.outage?'offline':!s.lastSuccess||now-s.lastSuccess>600?'stale':'online',activeSource:s.activeSource??null,lastSuccess:s.lastSuccess??null,latestPost:posts?.latest??null,latestAlert:alerts?.latest??null,newPosts:posts?.newPosts??0,alerts:alerts?.total??0,sourceHealth:health.results,uncertainNotifications:uncertain?.total??0,latency:{samples:n,median:n<2?null:n%2?values[Math.floor(n/2)]:(values[n/2-1]+values[n/2])/2,max:n?values[n-1]:null},experimentEnd:env.EXPERIMENT_END_AT||null};
}
export default {
 async scheduled(_event:ScheduledController,env:Env,_ctx:ExecutionContext) { await monitor(env); },
 async fetch(request:Request,env:Env):Promise<Response> {
  if(request.method!=='GET'&&request.method!=='HEAD') return new Response('Method not allowed',{status:405});
  const path=new URL(request.url).pathname;
  const headers={'Cache-Control':'public, max-age=60','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
  if(path==='/export.json') {
   const rows=await env.DB.prepare('SELECT id,published_at AS timestamp,detected_at,text,canonical_url AS url,source,kind,classification,baseline,notified,notification_status,detection_latency_seconds FROM posts WHERE detected_at>=? ORDER BY detected_at DESC').bind(Math.floor(Date.now()/1000)-7*86400).all<any>();
   return Response.json({generated_at:new Date().toISOString(),observations:rows.results.map(r=>({...r,timestamp:r.timestamp===null?null:new Date(r.timestamp*1000).toISOString(),detected_at:new Date(r.detected_at*1000).toISOString(),notified:Boolean(r.notified)}))},{headers});
  }
  if(path==='/status.json') return Response.json(await status(env),{headers});
  if(path!=='/') return new Response('Not found',{status:404});
  const s=await status(env);
  const labels:Record<string,string>={online:'オンライン',offline:'センサー停止',stale:'更新途絶',paused:'一時停止',initializing:'基準データ待ち'};
  const metric=(label:string,v:unknown)=>`<div class="metric"><dt>${label}</dt><dd>${escape(v)}</dd></div>`;
  const html=`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>T-MEWS — 状態</title><style>body{margin:0;background:#0b1220;color:#edf2fb;font:16px/1.65 system-ui,sans-serif}main{max-width:1000px;margin:auto;padding:32px 24px}header{display:flex;justify-content:space-between;align-items:center;gap:24px;flex-wrap:wrap;border-bottom:1px solid #34435d;padding-bottom:20px}h1{margin:0;font-size:30px;letter-spacing:.04em}p{color:#b8c6da}.badge{padding:8px 16px;border:1px solid #718aac;border-radius:24px;background:#192a42}.online{color:#8eedc1;border-color:#3ca783}dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(225px,1fr));gap:16px;margin:28px 0}.metric{padding:20px;background:#152238;border:1px solid #30425d;border-radius:12px}dt{color:#b8c6da;font-size:14px}dd{margin:8px 0 0;font-size:20px;overflow-wrap:anywhere}a{color:#8ac7ff}table{border-collapse:collapse;width:100%;text-align:left}td,th{padding:12px;border-bottom:1px solid #34435d}section{overflow-x:auto}.warn{color:#ffd285}small{font-size:14px;color:#b8c6da}</style><main><header><div><h1>🍄 T-MEWS</h1><small>@thsottiaux · Tibo Mushroom Early Warning System</small></div><strong class="badge ${s.state==='online'?'online':''}">${labels[s.state]}</strong></header><dl>${metric('現在のRSSソース',s.activeSource)}${metric('最終取得成功（5分ごと保存）',jst(s.lastSuccess))}${metric('最新投稿日時',jst(s.latestPost))}${metric('最新アラート',jst(s.latestAlert))}${metric('新規観測数（保存中の14日分）',s.newPosts)}${metric('送信済みアラート',s.alerts)}${metric('検知遅延 · 中央値',s.latency.median===null?'サンプル待ち':s.latency.median+'秒')}${metric('検知遅延 · 最大',s.latency.max===null?'サンプル待ち':s.latency.max+'秒')}</dl>${s.uncertainNotifications?`<p class="warn">送信失敗・結果未確認: ${s.uncertainNotifications}件。重複防止のため自動再送を停止しています。</p>`:''}<section><h2>ソースの状態</h2><table><thead><tr><th>ソース</th><th>状態</th><th>障害発生回数</th><th>最終エラー</th></tr></thead><tbody>${s.sourceHealth.map(h=>`<tr><td>${escape(h.source)}</td><td>${escape(h.state)}</td><td>${escape(h.failure_episodes)}</td><td>${escape(h.error)}</td></tr>`).join('')||'<tr><td colspan="4">まだ取得していません</td></tr>'}</tbody></table></section><p>検知遅延は公開日時から最初の観測まで。基準データを除いた${s.latency.samples}件で集計。RSS側の遅延や未掲載の返信は検知できません。</p><p>${s.experimentEnd?'実験終了: '+escape(jst(Math.floor(Date.parse(s.experimentEnd)/1000))):'実験終了日時は未設定'}</p><p><a href="/export.json">過去7日間をJSONで書き出す</a> · <a href="/status.json">状態JSON</a></p><small>時刻は日本時間。取得障害は全ソースで15分続いた場合に一度通知します。</small></main></html>`;
  return new Response(request.method==='HEAD'?null:html,{headers:{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"}});
 }
};

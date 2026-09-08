import type { Env, Fetcher, Classification, Item } from './types';
export const titles: Partial<Record<Classification,string>> = {RESET_ANNOUNCED:'🚨 T-MEWS: RESET予告',RESET_HINT:'👀 T-MEWS: リセット匂わせ',BANKED_RESET:'🍄 T-MEWS: しいたけ発生',LIMIT_CHANGE:'📈 T-MEWS: 利用枠変更'};
export const jst = (t: number | null) => t === null ? '不明' : new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',dateStyle:'short',timeStyle:'medium'}).format(new Date(t*1000))+' JST';
export async function notify(env: Env, id: string, kind: string, title: string, message: string, now: number, fetcher: Fetcher, post?: Item, classification?: Classification): Promise<void> {
 if (!env.PUSHOVER_APP_TOKEN || !env.PUSHOVER_USER_KEY) throw new Error('pushover_secrets_missing');
 const claim = await env.DB.prepare("INSERT OR IGNORE INTO notifications(id,post_id,kind,created_at,status) VALUES(?,?,?,?,'sending') RETURNING id").bind(id,post?.id??null,kind,now).first();
 if (!claim) return;
 let status='unknown';
 try {
  const body=new URLSearchParams({token:env.PUSHOVER_APP_TOKEN,user:env.PUSHOVER_USER_KEY,title,message:[...message].slice(0,1024).join(''),priority:classification==='RESET_ANNOUNCED'?'1':'0'});
  if(post?.url) { body.set('url',post.url); body.set('url_title','元のX投稿'); }
  const r=await fetcher('https://api.pushover.net/1/messages.json',{method:'POST',body,signal:AbortSignal.timeout(8000)});
  const data=await r.json() as {status?:number};
  status=r.ok && data.status===1 ? 'sent' : 'failed';
 } catch { /* An ambiguous response must never cause a duplicate delivery. */ }
 const statements=[env.DB.prepare('UPDATE notifications SET status=?,sent_at=? WHERE id=?').bind(status,status==='sent'?now:null,id),env.DB.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)').bind(`notification:${id}`,`notification_${status}`,now,JSON.stringify({kind,postId:post?.id??null}))];
 if(post) statements.push(env.DB.prepare('UPDATE posts SET notified=?,notification_status=? WHERE id=?').bind(status==='sent'?1:0,status,post.id));
 await env.DB.batch(statements);
}
export function alertMessage(post: Item, classification: Classification, latency: number | null) {
 return `${classification}\n投稿: ${jst(post.publishedAt)}\n検知遅延: ${latency===null?'不明':latency<60?`${latency}秒`:`${Math.floor(latency/60)}分${latency%60}秒`}\n\n${post.text}`;
}

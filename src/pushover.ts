import type { Env, Fetcher, Classification, Item, Verdict } from './types';
import {classify} from './classifier';
import {resetTiming} from './reset-time';
export const titles: Partial<Record<Classification,string>> = {RESET_ANNOUNCED:'💣リセット予告',RESET_HINT:'🍄注意報',BANKED_RESET:'💣リセット予告',CANDIDATE:'🍄注意報',LIMIT_CHANGE:'📈 T-MEWS: 利用枠変更'};
const changeLabels={postponed:'延期',cancelled:'取消',corrected:'時刻訂正・変更',denied:'実施否定'};
export function alertTitle(verdict:Verdict):string {
 if(verdict.change)return `🍄注意報（${changeLabels[verdict.change]}）`;
 if(verdict.display==='announcement')return '💣リセット予告';
 if(verdict.display==='advisory')return '🍄注意報';
 return titles[verdict.classification]??'🍄注意報';
}
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
const clip=(text:string,limit:number)=>[...text].length<=limit?text:[...text].slice(0,Math.max(0,limit-1)).join('')+'…';
function timingOriginal(line:string,source:string):string {
 const split=line.indexOf(': ');
 if(split<0)return clip(line,140);
 const label=line.slice(0,split+2);let original=line.slice(split+2);
 // Recover a formatter-shortened clause only when both literal ends identify one source span.
 const ends=original.split(' … ');
 if(ends.length===2) {
  const first=source.indexOf(ends[0]),last=source.indexOf(ends[1],first+ends[0].length);
  if(first>=0&&last>=0&&source.indexOf(ends[0],first+1)<0&&source.indexOf(ends[1],last+1)<0)
   original=source.slice(first,last+ends[1].length);
 }
 const budget=Math.max(40,140-[...label].length),chars=[...original];
 if(chars.length<=budget)return label+original;
 // This selects a verbatim display window; the time parser remains the only interpreter.
 const clock=/\b(?:midnight|noon|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\d{1,2}:\d{2})\b|\b(?:at|by|before|until|around|after)\s+\S+/i.exec(original);
 const index=clock?[...original.slice(0,clock.index)].length:0;
 const start=Math.max(0,index-25),window=chars.slice(start,start+budget-2).join('');
 return label+(start?'…':'')+window+(start+budget-2<chars.length?'…':'');
}
function timingSchedule(lines:string[],post:Item,budget:number):string {
 const source=post.text.replace(/\s+/g,' ').trim();
 const converted=lines.filter(line=>/日本時間/.test(line));
 const originals=lines.filter(line=>/（原文/.test(line)).map(line=>timingOriginal(line,source));
 const supporting=lines.filter(line=>!converted.includes(line)&&!/（原文/.test(line));
 // Reserve every converted time and its original clock before attribution or author prose.
 const essential=[...converted,...originals].join('\n');
 const selected=[essential];let remaining=budget-[...essential].length;
 for(const line of supporting) {
  if(remaining<=1)break;
  const detail=clip(line,Math.min(160,remaining-1));selected.push(detail);remaining-=[...detail].length+1;
 }
 return selected.filter(Boolean).join('\n');
}
export function alertMessage(post: Item, classification: Classification, latency: number | null, note = '', analysis?:Verdict) {
 const verdict=analysis??classify(post.text,post.related);
 const header = `${clip(note,180)}${classification}${verdict.change?' / '+changeLabels[verdict.change]:''}\n投稿時刻: ${jst(post.publishedAt)}\n検知遅延: ${latency===null?'不明':latency<60?`${latency}秒`:`${Math.floor(latency/60)}分${latency%60}秒`}\n`;
 let timing:string[]=[];
 try{timing=resetTiming(post,verdict.evidence);}catch{timing=['実施予定・期限: 日本時間：未確定（時刻解析失敗）'];}
 const schedule=timingSchedule(timing,post,Math.min(600,1024-[...header].length-160));
 const evidence=verdict.evidence&&post.text.includes(verdict.evidence)?verdict.evidence:post.text;
 const context=post.related?.filter(r=>r.text&&/\breset(?:s|ting|ted)?\b|🍄/i.test(r.text)).slice(0,1)
  .map(r=>`${r.relation==='reply'?'返信先':'引用元'}${r.author?`（@${r.author.replace(/^@/,'')}）`:''}: ${clip(r.text!,120)}\n${r.url}`).join('\n')??'';
 const prefix=header+(schedule?schedule+'\n':'')+'\n';
 const available=Math.max(0,1024-[...prefix].length);
 // Reserve room for the author's relevant words before optional surrounding text.
 const own=clip(`本人: ${evidence}`,context?Math.max(120,available-Math.min(260,[...context].length+1)):available);
 let message=prefix+own;
 if(context)message+='\n'+clip(context,Math.max(0,1024-[...message].length-1));
 if(evidence!==post.text) {
  const room=1024-[...message].length-6;
  if(room>60)message+='\n本文: '+clip(post.text,room);
 }
 return clip(message,1024);
}

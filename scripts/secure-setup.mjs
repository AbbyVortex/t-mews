import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {cfApi} from './cloudflare.mjs';
async function secret(name,value) {
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','secret','put',name,'--config','wrangler.local.jsonc'],{windowsHide:true,stdio:['pipe','ignore','ignore'],env:{...process.env,WRANGLER_LOG:'error',WRANGLER_SEND_METRICS:'false'}});
  child.on('error',()=>reject(new Error(`Could not start Wrangler for ${name}`)));
  child.on('close',code=>code===0?resolve():reject(new Error(`Cloudflare secret upload failed for ${name}. Refresh Wrangler login and retry.`)));
  child.stdin.on('error',()=>{});child.stdin.end(value+'\n');
 });
}
try {
 let input=''; for await(const chunk of process.stdin)input+=chunk;
 const {user,token}=JSON.parse(input);input='';
 if(!/^[a-zA-Z0-9]{30}$/.test(user)||!/^[a-zA-Z0-9]{30}$/.test(token))throw new Error('Expected two 30-character Pushover keys. No values were stored or printed.');
 const config=JSON.parse(await readFile('wrangler.local.jsonc','utf8'));
 const db=config.d1_databases[0].database_id;
 const query=(sql,params=[])=>cfApi(`/d1/database/${db}/query`,'POST',{sql,params});
 await secret('PUSHOVER_USER_KEY',user);await secret('PUSHOVER_APP_TOKEN',token);
 const now=Math.floor(Date.now()/1000);
 const claim=await query("INSERT OR IGNORE INTO notifications(id,kind,created_at,status) VALUES('test','test',?,'sending') RETURNING id",[now]);
 if(!claim[0]?.results?.length) {
  const old=await query("SELECT status FROM notifications WHERE id='test'");
  if(old[0]?.results?.[0]?.status==='sent') {console.log('Secrets saved. The test was already sent; no duplicate was sent.');process.exit(0);}
  throw new Error('A prior test result is uncertain or failed. No automatic resend. Ask Codex to inspect the non-secret status.');
 }
 let state='unknown';
 try {
  const response=await fetch('https://api.pushover.net/1/messages.json',{method:'POST',body:new URLSearchParams({token,user,title:'🍄 T-MEWS: 接続テスト',message:'T-MEWSの接続テストです。このテスト通知は1回だけ送信します。監視開始時には別途オンライン通知が届きます。',priority:'0'}),signal:AbortSignal.timeout(10000)});
  const result=await response.json();state=response.ok&&result.status===1?'sent':'failed';
 }catch{}
 await query("UPDATE notifications SET status=?,sent_at=? WHERE id='test'",[state,state==='sent'?now:null]);
 if(state!=='sent')throw new Error(`Pushover test status: ${state}. No automatic resend.`);
 console.log('Both Worker secrets saved. Exactly one Pushover test accepted.');
}catch(e){console.error(e instanceof Error?e.message:'Secure setup failed');process.exitCode=1;}

import {readFile} from 'node:fs/promises';
import path from 'node:path';
export async function cfApi(route,method='GET',body) {
 const local=JSON.parse(await readFile(process.env.WRANGLER_CONFIG||'wrangler.local.jsonc','utf8'));
 const account=local.account_id;
 if(!account)throw new Error('Set account_id in ignored wrangler.local.jsonc');
 const config=await readFile(path.join(process.env.APPDATA,'xdg.config','.wrangler','config','default.toml'),'utf8');
 const token=config.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
 if(!token)throw new Error('Wrangler login required');
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${route}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const result=await response.json();
 if(!response.ok||!result.success)throw new Error(`Cloudflare ${response.status}: ${JSON.stringify(result.errors?.map(e=>({code:e.code,message:e.message})))}`);
 return result.result;
}
if(process.argv[1]?.endsWith('cloudflare.mjs')) {
 for(const route of ['/subscriptions','/workers/account-settings','/workers/subdomain']) {
  try {console.log(JSON.stringify({route,result:await cfApi(route)}));}catch(e){console.log(String(e.message));}
 }
}

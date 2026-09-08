import {readFile} from 'node:fs/promises';
import {cfApi} from './cloudflare.mjs';
const config=JSON.parse(await readFile('wrangler.local.jsonc','utf8'));
const id=config.d1_databases[0].database_id;
const settings=await cfApi('/workers/scripts/t-mews/settings');
const schedules=await cfApi('/workers/scripts/t-mews/schedules');
const result=await cfApi(`/d1/database/${id}/query`,'POST',{sql:'SELECT id,kind,status,created_at,sent_at FROM notifications ORDER BY created_at DESC LIMIT 10'});
console.log(JSON.stringify({bindings:settings.bindings.map(b=>({name:b.name,type:b.type,...(b.type==='plain_text'?{value:b.text}:{})})),schedules,notifications:result[0]?.results},null,2));

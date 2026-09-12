import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { parseFeed } from '../src/sources';
const source={name:'fxtwitter',url:'https://fxtwitter.com/thsottiaux/feed.xml?with_replies=true&count=100'};
const xml=process.argv[2]?readFileSync(process.argv[2],'utf8'):await (await fetch(source.url,{signal:AbortSignal.timeout(8000)})).text();
const expected=(await parseFeed(xml,source)).length;
mkdirSync('work',{recursive:true});
// External requests are intercepted inside workerd; no real notifications are sent.
const bundled=await build({entryPoints:['src/index.ts'],bundle:true,format:'esm',platform:'browser',write:false});
const patched=`const fixture=${JSON.stringify(xml)};const nativeFetch=globalThis.fetch;globalThis.fetch=async function(input,init){if(String(input).includes('pushover.net'))return Response.json({status:1});return new Response(fixture);};\n${bundled.outputFiles[0].text}`;
const mf=new Miniflare({modules:true,script:patched,compatibilityDate:'2026-07-30',d1Databases:['DB'],bindings:{MONITOR_ENABLED:'true',SOURCES_JSON:JSON.stringify([source]),PUSHOVER_USER_KEY:'fixture',PUSHOVER_APP_TOKEN:'fixture'}});
try {
 const db=await mf.getD1Database('DB');
 for(const sql of readFileSync('migrations/0001_initial.sql','utf8').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
 // Miniflare dispatches the actual module's scheduled handler through its event entrypoint.
 const worker=await mf.getWorker();
 await worker.scheduled({cron:'* * * * *',scheduledTime:new Date()});
 await worker.scheduled({cron:'* * * * *',scheduledTime:new Date()});
 const p=await db.prepare('SELECT COUNT(*) n FROM posts').first<{n:number}>();
 const n=await db.prepare('SELECT kind,status,COUNT(*) n FROM notifications GROUP BY kind,status').all();
 if(p?.n!==expected||n.results.length!==1||(n.results[0] as any).kind!=='online')throw new Error('Unexpected simulation outcome');
 const page=await mf.dispatchFetch('https://local/');writeFileSync('work/status-preview.html',await page.text());
 const result={scheduledRuns:2,posts:p.n,notifications:n.results,verifiedAt:new Date().toISOString()};
 writeFileSync('work/simulation.json',JSON.stringify(result,null,2));console.log(result);
}finally{await mf.dispose();}

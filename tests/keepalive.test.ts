import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {keepalive} from '../src/actions/keepalive';

const repo = 'example/t-mews';
const token = 'unit-test-token';
const base = `https://api.github.com/repos/${repo}`;

function mock(options: {state?: string; private?: boolean; path?: string; error?: number} = {}) {
  const calls: {url: string; method: string}[] = [];
  const fetcher = (async(input: any, init: any) => {
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.ok(init.signal instanceof AbortSignal, 'each external request needs a timeout');
    assert.equal(init.redirect, 'error', 'credentials must not follow redirects');
    assert.equal(init.body, undefined, 'no dummy commit or state payload');
    calls.push({url: String(input), method: init.method});
    if (options.error) return new Response('upstream-private-detail', {status: options.error});
    if (String(input) === base) return Response.json({private: options.private ?? false});
    if (init.method === 'PUT') return new Response(null, {status: 204});
    return Response.json({state: options.state ?? 'active', path: options.path ?? '.github/workflows/monitor.yml'});
  }) as typeof fetch;
  return {calls, fetcher};
}

test('keepalive renews only the active monitor using the enable API, without commits or posts',async()=>{
 const h=mock();
 assert.deepEqual(await keepalive(repo,token,'true',h.fetcher),{status:'renewed',workflow:'monitor.yml'});
 assert.deepEqual(h.calls,[
  {url:base,method:'GET'},
  {url:base+'/actions/workflows/monitor.yml',method:'GET'},
  {url:base+'/actions/workflows/monitor.yml/enable',method:'PUT'}
 ]);
});

test('keepalive respects monitor pause and every disabled workflow state',async()=>{
 for(const enabled of ['false','', 'TRUE']) {
  const h=mock();
  assert.equal((await keepalive(repo,token,enabled,h.fetcher)).status,'skipped');
  assert.equal(h.calls.length,0);
 }
 for(const state of ['disabled_manually','disabled_inactivity','disabled_fork','deleted','unknown']) {
  const h=mock({state});
  assert.deepEqual(await keepalive(repo,token,'true',h.fetcher),{status:'skipped',reason:'workflow_not_active'});
  assert.ok(h.calls.every(c=>c.method==='GET'));
 }
});

test('keepalive fails closed on private repos, wrong workflows and invalid input',async()=>{
 for(const options of [{private:true},{path:'.github/workflows/other.yml'}]) {
  const h=mock(options);
  await assert.rejects(keepalive(repo,token,'true',h.fetcher));
  assert.ok(h.calls.every(c=>c.method==='GET'));
 }
 const h=mock();
 for(const invalid of ['../other','example/..','example/.','example/repo/other','example/repo?x=1'])
  await assert.rejects(keepalive(invalid,token,'true',h.fetcher));
 await assert.rejects(keepalive(repo,'','true',h.fetcher));
 assert.equal(h.calls.length,0);
});

test('keepalive errors expose neither tokens nor response bodies, and can be retried on the next run',async()=>{
 for(const error of [401,403,404,429,500]) {
  const h=mock({error});
  await assert.rejects(keepalive(repo,token,'true',h.fetcher),e=>{
   assert.ok(e instanceof Error);
   assert.ok(!e.message.includes(token) && !e.message.includes('upstream-private-detail'));
   return true;
  });
 }
 const h=mock();
 const deniedEnable=(async(input:any,init:any)=>init.method==='PUT'
  ?new Response('upstream-private-detail',{status:403}):h.fetcher(input,init)) as typeof fetch;
 await assert.rejects(keepalive(repo,token,'true',deniedEnable),/Keepalive API request failed \(403\)/);
 assert.equal((await keepalive(repo,token,'true',h.fetcher)).status,'renewed');
});

test('workflow separates weekly keepalive permission/secrets from five-minute monitoring',()=>{
 const yaml=readFileSync(new URL('../.github/workflows/monitor.yml',import.meta.url),'utf8');
 const monitor=yaml.split('  monitor:')[1].split('  keepalive:')[0];
 const keep=yaml.split('  keepalive:')[1];
 assert.match(yaml, /cron: '2-57\/5 \* \* \* \*'/);
 assert.match(yaml, /cron: '23 4 \* \* 1'/);
 assert.match(monitor, /github\.event\.schedule == '2-57\/5 \* \* \* \*'/);
 assert.doesNotMatch(monitor, /actions: write/);
 assert.match(keep, /actions: write/);
 assert.match(keep, /contents: read/);
 assert.match(keep, /vars\.T_MEWS_ENABLED == 'true'/);
 assert.doesNotMatch(keep, /PUSHOVER|needs:|pnpm install/);
});

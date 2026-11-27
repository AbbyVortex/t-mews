import test from 'node:test';
import assert from 'node:assert/strict';
import {classify} from '../src/classifier';
import type {LiveResult} from '../src/ai-live-classifier';
import {radarSignal, saveRadarSignal} from '../src/radar-watch';
import {LocalD1} from '../src/actions/sqlite';
import type {Item} from '../src/types';

const published = Date.parse('2026-11-27T00:00:00Z') / 1000;
const now = published + 300;
const post = (text: string, extra: Partial<Item> = {}): Item => ({
  id: 'x:123', text, publishedAt: published, kind: 'post', url: null, xStatusId: '123', source: 'fixture', fingerprint: 'test', ...extra
});
function evaluate(text: string, ai?: LiveResult, extra: Partial<Item> = {}, at = now) {
  const item = post(text, extra);
  return radarSignal(item, classify(item.text, item.related), at, at, ai);
}
const attention: LiveResult = {category:'attention', startsResetWatch:true, allowanceScope:'not_applicable', rationale:'fixture', uncertainty:'', confidence:1};

test('radar: semantic hints can start a watch; chatter, plan attention, cancellations and diagnostics cannot', () => {
  const related = [{relation:'reply', xStatusId:'122', url:'https://x.com/example/status/122', text:'Are we getting a banked reset?', provenance:'feed'}] as const;
  assert.equal(evaluate('👀', attention, {kind:'reply',related:[...related]})?.kind,'hint');
  assert.equal(evaluate('👀', {...attention, startsResetWatch:false}, {kind:'reply',related:[...related]}),null);
  assert.equal(evaluate('What if we doubled the limits for Plus?', {...attention, allowanceScope:'included'}),null);
  assert.equal(evaluate('We thought about resets', {...attention, category:'chatter'}),null);
  assert.equal(evaluate('The usage reset has been cancelled.', attention),null);
  assert.equal(evaluate('The usage reset has been postponed.', attention),null);
  assert.equal(evaluate('Banked 1/2', {...attention, category:'announcement'})?.kind,'announcement');
});

test('radar: machine fallback, publication freshness and exact future schedule', () => {
  assert.equal(evaluate("Who says it won't reset in a while 👀")?.kind,'hint');
  const expected = {version:1,id:'x:123',kind:'announcement',publishedAt:published*1000,observedAt:now*1000,dueAt:null};
  assert.deepEqual(evaluate('Banked 1/2'),expected);
  for (const extra of [{kind:'repost' as const}, {publishedAt:null}, {publishedAt:now+120}, {publishedAt:now-3601}])
    assert.equal(evaluate('Banked 1/2', undefined, extra),null);
  assert.equal(evaluate('Codex usage limits doubled for all users.'),null);
  assert.equal(evaluate('The usage reset has been cancelled.'),null);
  const due = Date.parse('2026-11-27T18:00:00Z');
  assert.equal(evaluate('Reset will land at 18:00 UTC today.',undefined,{},now+7200)?.dueAt,due);
  for (const wording of ['by','around','after'])
    assert.equal(evaluate(`Reset will land ${wording} 18:00 UTC today.`)?.dueAt,null);
  assert.equal(evaluate('Banked reset expires at 18:00 UTC today.',attention)?.dueAt,null);
  assert.equal(evaluate('Reset will land at 18:00 today.')?.dueAt,null);
});

test('radar: reversed AI completion, repeated RSS and tied dates never move the public cursor backwards', async () => {
  const local = new LocalD1();
  try {
    const signal=evaluate('Banked 1/2')!;
    for (const change of [
      {id:'x:124'}, {id:'x:123'}, {id:'x:199',publishedAt:signal.publishedAt-1000},
      {id:'x:124',observedAt:signal.observedAt+3600000}
    ]) await saveRadarSignal(local.asD1(), {...signal,...change}).run();
    const row=local.snapshot().tables.state.find(r=>r.key==='radarWatch')!;
    assert.deepEqual(JSON.parse(row.value),{...signal,id:'x:124'});
  } finally {local.close();}
});

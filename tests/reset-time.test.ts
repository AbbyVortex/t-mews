import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resetTiming} from '../src/reset-time';
import type {Item, RelatedPost} from '../src/types';

const published = Date.parse('2026-09-12T01:00:00Z') / 1000;
function post(text: string, extra: Partial<Item> = {}): Item {
  return {id: 'x:123', xStatusId: '123', url: 'https://x.com/thsottiaux/status/123', fingerprint: 'fixture', text,
    publishedAt: published, source: 'fixture', kind: 'post', ...extra};
}
const output = (text: string, extra: Partial<Item> = {}) => resetTiming(post(text, extra)).join('\n');
function parent(text: string, extra: Partial<RelatedPost> = {}): RelatedPost {
  return {relation: 'reply', xStatusId: '122', url: 'https://x.com/example/status/122', author: 'example', text,
    publishedAt: published - 300, provenance: 'feed', ...extra};
}

test('reset timing distinguishes the stated deadline from publication and unknown midnight', () => {
  const result = output('And of course, a reset is also landing by midnight today.');
  assert.match(result, /リセット期限（原文）: And of course, a reset is also landing by midnight today\./);
  assert.match(result, /リセット期限（日本時間）: 未確定/);
  assert.match(result, /midnight は日付の境界が曖昧/);
  assert.doesNotMatch(result, /2026\/09/);
  assert.match(output('A reset lands by midnight today PT.'), /未確定/);
});

test('explicit fixed zones use the publication date in that zone for today and tomorrow', () => {
  assert.match(output('Reset will land at 6pm PST today.'), /2026\/09\/12 11:00 JST/);
  assert.match(output('Reset will land at 6pm PDT tomorrow.'), /2026\/09\/13 10:00 JST/);
  assert.match(output('Reset will land at 6pm PST tomorrow.'), /2026\/09\/13 11:00 JST/);
  assert.match(output('Reset will land at 18:00 JST today.'), /2026\/09\/12 18:00 JST/);
  assert.match(output('Reset will land at 18:00 UTC today.'), /2026\/09\/13 03:00 JST/);
  assert.match(output('Reset will land at 6 p.m. UTC today.'), /2026\/09\/13 03:00 JST/);
  assert.match(output('Reset will land at 18:00 UTC+09:00 today.'), /2026\/09\/12 18:00 JST/);
  assert.match(output('Reset will land at 18:00 GMT-0700 today.'), /2026\/09\/12 10:00 JST/);
});

test('Pacific wall-clock dates use DST and correctly cross the year boundary', () => {
  assert.match(output('Reset will land at 6pm PT today.'), /2026\/09\/12 10:00 JST/);
  assert.match(output('Reset will land at 6pm Pacific Time on 2026-12-31.'), /2027\/01\/01 11:00 JST/);
  assert.match(output('Reset will land at 6pm America/Los_Angeles tomorrow.', {
    publishedAt: Date.parse('2026-12-31T23:30:00-08:00') / 1000
  }), /2027\/01\/02 11:00 JST/);
});

test('DST gaps and duplicated local times are left unconfirmed', () => {
  assert.match(output('Reset will land at 02:30 PT on 2026-03-08.'), /未確定（夏時間の切り替えで存在しない時刻）/);
  assert.match(output('Reset will land at 01:30 PT on 2026-11-01.'), /未確定（夏時間の切り替えで時刻が重複する）/);
  assert.match(output('Reset will land at 02:30 PT on 2026-11-01.'), /2026\/11\/01 19:30 JST/);
});

test('missing timezone, date, AM/PM or publication anchor is never guessed', () => {
  assert.match(output('Reset will land at 6pm tomorrow.'), /未確定（タイムゾーンの明示なし）/);
  assert.match(output('Reset will land at 6pm PST.'), /未確定（日付を確定できない）/);
  assert.match(output('Reset will land at 6 PST tomorrow.'), /未確定（午前・午後を確定できない）/);
  assert.match(output('Reset will land at 6:00 PT tomorrow.'), /未確定（午前・午後を確定できない）/);
  assert.match(output('Reset will land at 06:00 PT tomorrow.'), /2026\/09\/12 22:00 JST/);
  assert.match(output('Reset will land at 6pm PST tomorrow.', {publishedAt: null}), /未確定（日付を確定できない）/);
  assert.match(output('Reset will land at 6pm PST on Friday.'), /未確定（日付を確定できない）/);
  assert.match(output('Reset will land at 6pm PST on 2026-02-30.'), /未確定（日付を確定できない）/);
  assert.match(output('Reset will land at 14pm PST tomorrow.'), /未確定/);
  assert.match(output('Reset will land at 25:00 PST tomorrow.'), /未確定/);
  assert.match(output('Reset will land at 18:00 UTC+25:00 tomorrow.'), /未確定/);
});

test('deadline and approximate timing retain their qualifier', () => {
  assert.match(output('Reset will land by 18:00 UTC on 2026-09-12.'), /リセット期限（日本時間）: 2026\/09\/13 03:00 JST/);
  assert.match(output('Reset will land around 6pm PDT tomorrow.'), /10:00 JST 頃/);
  assert.match(output('Reset will land after 6pm PDT tomorrow.'), /10:00 JST より後/);
  assert.match(output('Reset will land at noon JST today.'), /2026\/09\/12 12:00 JST/);
});

test('ordinary engineering times and unrelated reset prose produce no timing claim', () => {
  for (const text of [
    'We fixed model quality at 6pm PT today.',
    'We will reset the cache at 6pm PT today.',
    'A reset and a quick update. We fixed quality at 6pm PT today.',
    'a reset and a quick update. we fixed quality at 6pm PT today.',
    'We fixed quality at 6pm PDT today before a reset later.',
    'Resetting the usage limits tomorrow.',
    'Codex engineering performance continues to improve.'
  ]) assert.deepEqual(resetTiming(post(text)), [], text);
  const result = output('We fixed quality at 6pm PT today. A reset will land by 8pm UTC tomorrow.');
  assert.match(result, /2026\/09\/14 05:00 JST/);
  assert.doesNotMatch(result, /fixed quality/);
});

test('mushroom distribution and an adjacent claim deadline retain reset timing', () => {
  assert.match(output('🍄 distribution lands at 6pm UTC tomorrow.'), /2026\/09\/14 03:00 JST/);
  const result = output('The banked reset has landed. Claim it before 6pm UTC tomorrow.');
  assert.match(result, /リセット期限（日本時間）: 2026\/09\/14 03:00 JST/);
  assert.match(result, /直前の本人によるリセット配布記述/);
  assert.deepEqual(resetTiming(post('We shipped a feature. Claim it before 6pm UTC tomorrow.')), []);
});

test('unparsed timing syntax remains visible and the original excerpt cannot hide JST output', () => {
  for (const text of ['Reset tomorrow morning.', 'A reset at tea-time.', 'A reset in a few hours.']) {
    const result = output(text);
    assert.match(result, /原文/);
    assert.match(result, /未確定（時刻表現はあるが対応範囲外）/);
  }
  const result = output(`A reset will land ${'for paid subscribers '.repeat(25)}at 6pm UTC tomorrow.`);
  assert.ok([...result.split('\n')[0]].length < 210);
  assert.match([...result].slice(0, 400).join(''), /2026\/09\/14 03:00 JST/);
});

test('only the explicitly linked reset can supply timezone to a short author reply', () => {
  const linked = parent('We will reset usage at 6pm PT tomorrow.');
  const result = output('Landing at 8pm today.', {kind: 'reply', related: [linked]});
  assert.match(result, /2026\/09\/12 12:00 JST/);
  assert.match(result, /原文・本人の記述/);
  assert.match(result, /返信先 https:\/\/x\.com\/example\/status\/122 のリセット記述/);
  assert.match(result, /時区を参照: PT/);
  assert.doesNotMatch(result, /6pm|完了/);
  assert.match(output('Landing at 8pm today.', {related: [parent(linked.text!, {relation: 'quote', provenance: 'saved'})]}), /引用元/);
});

test('related timing does not replace the author date or clock or override an explicit zone', () => {
  const linked = parent('A reset will land at 6pm PT tomorrow.');
  assert.match(output('Landing at 8pm.', {kind: 'reply', related: [linked]}), /未確定（日付を確定できない）/);
  assert.match(output('Landing at 8pm JST today.', {kind: 'reply', related: [linked]}), /2026\/09\/12 20:00 JST/);
  assert.deepEqual(resetTiming(post('Sounds good.', {kind: 'reply', related: [linked]})), []);
  assert.deepEqual(resetTiming(post('We fixed quality at 8pm today.', {kind: 'reply', related: [linked]})), []);
  assert.deepEqual(resetTiming(post('Landing at 8pm today.', {related: [parent('We fixed quality at 6pm PT tomorrow.')]})), []);
  assert.match(output('Landing at 8pm today.', {related: [parent('A reset is coming. We fixed quality at 6pm PT today.')]}), /未確定（タイムゾーンの明示なし）/);
});

test('ambiguous multiple times, multiple contexts and malformed input never fabricate an instant', () => {
  assert.match(output('Reset will land at 6pm or 8pm PT tomorrow.'), /未確定（複数の時刻/);
  assert.match(output('Reset will land at 6pm PST or PDT tomorrow.'), /未確定（タイムゾーン/);
  assert.deepEqual(resetTiming(post('Landing at 8pm today.', {related: [parent('A reset lands at 6pm PT.'), parent('A reset lands at 6pm UTC.', {xStatusId: '121'})]})), []);
  assert.deepEqual(resetTiming(post('A reset will land at 6pm JST today.', {kind: 'repost'})), []);
  assert.doesNotThrow(() => resetTiming(post('A reset will land at 6pm PT today.', {publishedAt: Number.MAX_VALUE})));
  assert.deepEqual(resetTiming(post('A reset is possible.'), 'A reset will land at 6pm PST tomorrow.'), []);
});

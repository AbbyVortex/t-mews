import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classify} from '../src/classifier';
import type {Classification} from '../src/types';
import {runAction, type Store} from '../src/actions/run';
import {LocalD1, type Snapshot} from '../src/actions/sqlite';

interface BaselinePost {
  id: string; url: string; publishedAt: number; text: string;
  originalClassification: Classification; expected: Classification; notify: boolean; rationale: string;
  expectedDisplay?: 'announcement' | 'advisory' | 'limit';
}
const {posts}: {posts: BaselinePost[]} = JSON.parse(readFileSync(new URL('./fixtures/tibo-baseline-89.json', import.meta.url), 'utf8'));
const boundaries: {text: string; expectedNotify: boolean; expectedDisplay?: string; reason: string}[] =
  JSON.parse(readFileSync(new URL('./fixtures/classifier-boundaries.json', import.meta.url), 'utf8'));
const newPosts: {posts: Omit<BaselinePost, 'rationale'>[]} = JSON.parse(readFileSync(new URL('./fixtures/tibo-new-posts-2026-09-12.json', import.meta.url), 'utf8'));
const announcementBoundaries: {text: string; expected?: Classification; expectedNotify: boolean; expectedDisplay?: string; reason: string}[] =
  JSON.parse(readFileSync(new URL('./fixtures/announcement-boundaries.json', import.meta.url), 'utf8'));

for (const post of newPosts.posts) {
  test(`live regression ${post.id}: ${post.expected}`, () => {
    const actual = classify(post.text);
    assert.equal(actual.classification, post.expected);
    assert.equal(actual.notify, post.notify);
    if (post.expectedDisplay) assert.equal(actual.display, post.expectedDisplay);
  });
}
for (const [index, example] of announcementBoundaries.entries()) {
  test(`announcement boundary ${index + 1}: ${example.reason}`, () => {
    const actual = classify(example.text);
    assert.equal(actual.notify, example.expectedNotify, example.text);
    if (example.expected) assert.equal(actual.classification, example.expected);
    if (example.expectedDisplay) assert.equal(actual.display, example.expectedDisplay);
  });
}

test('baseline corpus contains all 89 unique, manually labelled public posts', () => {
  assert.equal(posts.length, 89);
  assert.equal(new Set(posts.map(p => p.id)).size, 89);
  assert.equal(posts.filter(p => p.notify).length, 21);
});

for (const post of posts) {
  test(`baseline ${post.id}: ${post.expected}`, () => {
    const actual = classify(post.text);
    assert.equal(actual.classification, post.expected, post.rationale);
    assert.equal(actual.notify, post.notify, post.rationale);
    if (post.expectedDisplay) assert.equal(actual.display, post.expectedDisplay, post.rationale);
  });
}

for (const [index, example] of boundaries.entries()) {
  test(`classifier boundary ${index + 1}: ${example.reason}`, () => {
    const actual = classify(example.text);
    assert.equal(actual.notify, example.expectedNotify, example.text);
    if (example.expectedDisplay) assert.equal(actual.display, example.expectedDisplay, example.text);
  });
}

test('spelling and future/completed reset variants keep the intended class', () => {
  for (const text of [
    'Reset will land around 2pm PST tomorrow.',
    'We are resetting usage for all paid users.',
    'We are reseting usage for all paid users.',
    'Your Codex and ChatGPT Work reset will land at 6pm PST.',
    'All Codex usage has now been reset for everyone.',
    'We are resetting usage for all paid users, which could fix the earlier drain.'
  ]) assert.equal(classify(text).classification, 'RESET_ANNOUNCED', text);
  assert.equal(classify('The banked reset has landed.').classification, 'BANKED_RESET');
  assert.equal(classify('I will find the reset button tomorrow.').classification, 'RESET_HINT');
  assert.equal(classify('If we ever launch the feature, we will reset usage for all paid Codex users tomorrow.').classification, 'RESET_HINT');
});

function feed(items: {url: string; text: string; publishedAt: number}[]): string {
  return `<rss><channel><title>Tibo @thsottiaux</title>${items.map(p =>
    `<item><link>${p.url}</link><pubDate>${new Date(p.publishedAt * 1000).toUTCString()}</pubDate><description><![CDATA[${p.text.replaceAll(']]>', ']]]]><![CDATA[>')}]]></description></item>`
  ).join('')}</channel></rss>`;
}

test('Actions upgrade keeps all 89 baseline rows and notification ledger; fresh signals still alert once', async () => {
  const now = Date.parse('2026-09-08T08:18:15Z') / 1000;
  let saved: Snapshot | undefined;
  const store: Store = {
    load: async () => structuredClone(saved),
    save: async next => { saved = structuredClone(next); }
  };
  const messages: URLSearchParams[] = [];
  let xml = feed(posts);
  const fetcher = (async (input: any, init: any) => {
    if (String(input).includes('pushover.net')) {
      messages.push(new URLSearchParams(init.body));
      return Response.json({status: 1});
    }
    return new Response(xml);
  }) as typeof fetch;
  const secrets = {user: 'u'.repeat(30), token: 't'.repeat(30)};
  await runAction('test', store, secrets, fetcher, now);
  await runAction('monitor', store, secrets, fetcher, now);
  assert.equal(messages.length, 2, 'only mock test and online, no historical alerts');
  assert.equal(saved!.tables.posts.length, 89);
  assert.ok(saved!.tables.posts.every(p => p.baseline === 1 && p.notification_status === 'baseline' && p.notified === 0));

  // Emulate loading state written by the previous classifier, including its missed labels.
  const old = new LocalD1(saved);
  try {
    for (const post of posts) old.sqlite.prepare('UPDATE posts SET classification=?,reason=? WHERE id=?')
      .run(post.originalClassification, 'previous classifier reason', post.id);
    saved = old.snapshot();
  } finally { old.close(); }
  const baselineBefore = structuredClone(saved.tables.posts);
  const ledgerBefore = structuredClone(saved.tables.notifications);
  xml = feed([...posts].reverse().map(p => ({...p, url: p.url.replace('x.com', 'nitter.net')})));
  await runAction('monitor', store, secrets, fetcher, now + 300);
  await runAction('monitor', store, secrets, fetcher, now + 600);
  assert.deepEqual(saved!.tables.posts, baselineBefore, 'existing observations must not be reclassified or rewritten');
  assert.deepEqual(saved!.tables.notifications, ledgerBefore, 'existing delivery claims must remain intact');
  assert.equal(messages.length, 2, 'no re-alert after classifier upgrade or alternate source URL');

  const fresh = [
    {text: 'Reset will land around 2pm PST tomorrow.', expected: 'RESET_ANNOUNCED'},
    {text: 'The banked reset has landed.', expected: 'BANKED_RESET'},
    {text: 'I will find the reset button tomorrow.', expected: 'RESET_HINT'},
    {text: 'Tomorrow we will bring back the 5h limit for Plus accounts across Codex.', expected: 'LIMIT_CHANGE'}
  ];
  xml = feed(fresh.map((p, i) => ({...p, url: `https://x.com/thsottiaux/status/999900${i}`, publishedAt: now + 650})));
  await runAction('monitor', store, secrets, fetcher, now + 900);
  await runAction('monitor', store, secrets, fetcher, now + 1200);
  assert.equal(messages.length, 6, 'each new signal sends exactly one mock alert');
  for (const [i, post] of fresh.entries()) {
    const row: Record<string, unknown> | undefined = saved!.tables.posts.find(p => p.id === `x:999900${i}`);
    assert.ok(row);
    assert.equal(row.classification, post.expected);
    assert.equal(row.notified, 1);
    assert.equal(saved!.tables.notifications.filter(n => n.id === `post:${row.id}`).length, 1);
  }
  assert.deepEqual(saved!.tables.posts.filter(p => p.baseline), baselineBefore);
  assert.equal(messages[2].get('priority'), '1');
  assert.ok(messages.slice(3).every(m => m.get('priority') === '0'));
});

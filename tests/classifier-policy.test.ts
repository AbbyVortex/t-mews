import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classify} from '../src/classifier';
import type {RelatedPost} from '../src/types';

const related: RelatedPost[] = [{relation: 'reply', xStatusId: '123456789',
  url: 'https://x.com/example/status/123456789', text: 'We will reset all Codex usage by midnight.',
  author: 'example', provenance: 'feed'}];

for (const text of [
  'RESET!', 'Resetting...', 'ＲＥＳＥＴ', 'reset_button',
  'when I say excellent service for existing users, that includes the occasional reset',
  'I was gifted a new reset button today.',
  'The password reset will land tomorrow in Codex.',
  'Codex occasionally resets the database.',
  'I enjoy resetting Codex usage for demos.',
  'Codex has a button for resetting usage.',
  'The documentation explains resetting Codex usage.',
  'We can reset usage for paid Codex users.',
  'We will reset Codex usage if the tests pass.',
  'Could you reset my usage?',
]) {
  test(`literal author reset advisory: ${text}`, () => {
    const actual = classify(text);
    assert.equal(actual.notify, true);
    assert.equal(actual.display, 'advisory');
    assert.notEqual(actual.classification, 'RESET_ANNOUNCED');
    assert.ok(actual.evidence);
  });
}

for (const [text, change] of [
  ['The reset is postponed until tomorrow.', 'postponed'],
  ['We cancelled the reset.', 'cancelled'],
  ['Correction: the reset will land at 7pm.', 'corrected'],
  ["We won't reset usage tomorrow.", 'denied'],
] as const) {
  test(`reset update remains an advisory: ${change}`, () => {
    const actual = classify(text);
    assert.equal(actual.notify, true);
    assert.equal(actual.display, 'advisory');
    assert.equal(actual.change, change);
  });
}

for (const text of ['Meant 2pm obviously.', 'Moved to tomorrow.', 'Cancelled.', '👀', 'Yes.']) {
  test(`related reset supports an advisory only: ${text}`, () => {
    const actual = classify(text, related);
    assert.equal(actual.notify, true);
    assert.equal(actual.display, 'advisory');
    assert.equal(actual.evidence, text);
    assert.notEqual(actual.classification, 'RESET_ANNOUNCED');
    assert.equal(classify(text).notify, false, 'no invisible parent context is assumed');
  });
}

test('related reset content never upgrades the author response into an announcement', () => {
  const actual = classify('Thanks for sharing this.', [{...related[0], relation: 'quote'}]);
  assert.equal(actual.display, 'advisory');
  assert.equal(actual.notify, true);
  assert.equal(actual.evidence, 'Thanks for sharing this.');
});

test('a quote action supports an advisory with an empty or long author comment', () => {
  for (const text of ['', 'Here is my detailed commentary. '.repeat(100)]) {
    const actual = classify(text, [{...related[0], relation: 'quote'}]);
    assert.equal(actual.notify, true);
    assert.equal(actual.display, 'advisory');
    assert.equal(actual.evidence, text.trim());
  }
});

test('adjacent reset corrections preserve the author correction evidence', () => {
  for (const [text, change, evidence] of [
    ['Reset update. Cancelled.', 'cancelled', 'Cancelled.'],
    ['Reset is coming. Correction: 7pm tomorrow.', 'corrected', 'Correction: 7pm tomorrow.'],
    ['Reset update. Moved to tomorrow.', 'postponed', 'Moved to tomorrow.'],
  ]) {
    const actual = classify(text);
    assert.equal(actual.notify, true);
    assert.equal(actual.display, 'advisory');
    assert.equal(actual.change, change);
    assert.equal(actual.evidence, evidence);
  }
  assert.equal(classify('Reset is coming. Cancelled a quality experiment.').change, undefined);
  const mixed = classify('We cancelled the reset. We doubled the weekly Codex allowance for Plus users.');
  assert.equal(mixed.display, 'advisory');
  assert.equal(mixed.change, 'cancelled');
});

test('a denial of cancellation is not presented as a cancelled reset', () => {
  for (const text of ["The reset won't be cancelled.", 'We are not delaying the reset.',
    'We might cancel the reset.', 'Can we cancel the reset?', 'Is the reset postponed?']) {
    const actual = classify(text);
    assert.equal(actual.notify, true);
    assert.equal(actual.display, 'advisory');
    assert.equal(actual.change, undefined);
  }
});

test('clear author reset and banked distribution still receive announcement styling', () => {
  for (const text of ['We are resetting usage for all paid users.',
    'A reset is also landing by midnight today.', 'The banked reset has landed.',
    'The reset is complete.', 'The usage reset will happen tomorrow.',
    'The reset has been completed.', "Reset's done.",
    'All paid Codex usage has now been reset.']) {
    assert.equal(classify(text).display, 'announcement', text);
  }
  const actual = classify('We will give all paid Codex users a 🍄 today.');
  assert.equal(actual.notify, true);
  assert.equal(actual.display, 'announcement');
  assert.equal(actual.classification, 'BANKED_RESET');
});

test('banked topic plus a different distributed object stays an advisory', () => {
  for (const text of ['Banked resets are getting a clearer button in Codex.',
    'Users with banked resets will get a new dashboard.',
    'Some banked resets failed. Affected users with a broken laptop are getting another one.']) {
    assert.equal(classify(text).notify, true);
    assert.equal(classify(text).display, 'advisory');
  }
});

test('unrelated emoji and technical discussion remain below the threshold', () => {
  for (const text of ['🍄', '👀', 'Codex made Astra benchmarks faster.', 'We fixed database latency.']) {
    assert.equal(classify(text).notify, false, text);
  }
  assert.equal(classify('We doubled the weekly Codex allowance for Plus users.').display, 'limit');
});

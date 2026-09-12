import type { Classification, RelatedPost, Verdict } from './types';

const RESET = /\breset(?:s|ting)?\b/;
const PRODUCT = /\b(?:codex|chatgpt(?:\s*work)?|paid|plus|pro|business|subscriptions?|plans?)\b/;
const USAGE_CONTEXT = /\b(?:codex|chatgpt\s*work|usage|limits?|quota|allowance|subscriptions?|paid users?)\b/;
const ALLOWANCE = /\b(?:(?:usage|rate) limits?|(?:weekly|5h|5[ -]hour|five[ -]hour) (?:codex |chatgpt(?: work)? )?(?:usage )?limits?|weekly (?:usage|allowance)|quotas?|allowances?|usage (?:consumption|allocation))\b/;
const TECHNICAL_RESET = /\b(?:password|branch|cache|database|connection|counter|git|session|repository|router|server|device|layout|workspace|project)(?:s)?\s+reset\b|\breset(?:ting)? (?:the |a |your |my )?(?:usage counters?|passwords?|branches?|cache|database|connection|counter|git|session|repository|router|server|device|(?:ui )?layout|settings|workspace|project)\b/;
const TECHNICAL_LIMIT = /\b(?:context(?: window)?|memory|speed|throughput|hardware|recursion|stack|storage|disk|concurrency|payload|api) (?:usage|limits?|quota)\b|\blimits? of (?:the )?model speed\b/;
const FORWARD = /\b(?:soon|tomorrow|tonight|today|later|around|in a while|next|this (?:morning|evening|week)|at \d|by \d|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{4}-\d{2}-\d{2})\b|👀/;
const DENIAL = /\b(?:not|never|no|won't|will not|can't|cannot|don't|doesn't|didn't|haven't|hasn't|isn't|aren't|wasn't|weren't)\b/;
const UNCERTAIN = /\b(?:if|might|maybe|could|perhaps|may|would|should|please|hoping|hope|can you)\b/;
const GENERAL_DISCUSSION = /\b(?:occasionally|often|sometimes|usually|normally|discuss(?:ing)?|enjoy(?:ing)?|like|love|explain(?:s|ed|ing)?|documentation|can|able to|how to|(?:button|feature|option|function|tool) (?:for|to))\b/;

// Match the assertion itself. Qualifiers after it (e.g. grant eligibility) do not veto it.
const EXPLICIT_RESET = /\b(?:reset(?:ting)? (?:the |your |my |all |everyone's )?(?:codex (?:and chatgpt work )?)?(?:usage(?: limits?)?|limits?|quotas?|allowances?)|(?:full|global) reset (?:of )?(?:the )?(?:usage|limits?|quota|allowance)|(?:limits?|usage|quota|allowance) (?:will (?:be )?|(?:has|have) (?:now )?been |(?:is|are) being |(?:is|are|was|were) (?:now )?)reset|all reset for everyone)\b/;
const RESET_DELIVERY = /\breset (?:will (?:also |now )?(?:land|arrive|happen|take place|be completed)|(?:has|have) (?:also |now |already )?(?:landed|arrived)|(?:has|have) (?:also )?been (?:propagated|completed)|is (?:also |now |already )?(?:landing|rolling out|coming|happening|complete|completed|done|finished))\b/;
const BANKED_ACTION = /\b(?:credit(?:ed|ing)?|giv(?:e|es|ing)|gave|grant(?:s|ed|ing)?|distribut(?:e|es|ed|ing)|receiv(?:e|es|ed|ing)|(?:(?:is|are|will be) getting|will get) (?:(?:a|one|another|an additional|[1-9]\d*) )?banked resets?|land(?:s|ed|ing)?|arriv(?:e|es|ed|ing)|roll(?:s|ed|ing)? out|no longer (?:available|eligible|valid)|available|expir(?:e|es|ed|ing)|extend(?:s|ed|ing)?|compensat\w*|promotional|eligible|eligibility (?:now )?(?:includes|excludes|changes|has changed)|will be there|covered with|do the (?:full )?banked reset)\b/;
const BANKED_REPLACEMENT = /\b(?:(?:everyone|anyone|users?|subscribers?|those) who (?:used|redeemed) (?:one|it|a banked reset)(?: (?:in|during) the affected (?:time window|period))?|affected (?:users?|subscribers?|accounts?)) (?:(?:is|are) (?:getting|receiving)|will (?:get|receive)) (?:another|a replacement|one more) (?:one|reset)\b/;
const LIMIT_ACTION = /\b(?:increas\w*|decreas\w*|doubl\w*|tripl\w*|reduc\w*|rais\w*|lower\w*|chang(?:e|es|ed|ing)|boost\w*|bring(?:ing)? back|brought back|reintroduc\w*|remov\w*|lift(?:ed|ing)?|disabl\w*|enabl\w*|no longer (?:have|has|apply|applies|enforce|enforces|enabled|required)|(?:is|are) now \d+(?:\.\d+)?\s*(?:x|%)|(?:more|less|fewer) usage|usage.{0,35}(?:further|faster|slower))\b/;

interface Clause { text: string; question: boolean; conditional: boolean }

function clauses(text: string): Clause[] {
  // Keep question scope, but isolate unrelated sentences and coordinated claims.
  return text.split(/(?<=[.!?;])\s+|\n+/).flatMap(sentence =>
    sentence.split(/,|\s+(?:but|however|and(?=\s+(?:we|i|you|they|a|an|the|it)\b))\s+/)
      .map(part => ({text: part.trim(), question: sentence.endsWith('?'), conditional: /^\s*(?:if|unless|assuming|provided)\b/.test(sentence)}))
  );
}

function assertion(clause: Clause, pattern: RegExp, announcement = false): boolean {
  if (clause.question || clause.conditional) return false;
  for (const match of clause.text.matchAll(new RegExp(pattern.source, 'g'))) {
    const prefix = clause.text.slice(0, match.index);
    const suffix = clause.text.slice(match.index + match[0].length);
    if (!DENIAL.test(prefix) && !UNCERTAIN.test(prefix) && (!announcement || !GENERAL_DISCUSSION.test(prefix))
      && !/\b(?:if|unless|assuming|provided)\b/.test(suffix)) return true;
  }
  return false;
}

function verdict(classification: Classification, reason: string): Verdict {
  return {classification, notify: !['CANDIDATE', 'IRRELEVANT'].includes(classification), reason};
}

function hasBankedReplacement(text: string): boolean {
  const sentences = text.split(/(?<=[.!?;])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  for (let i = 1; i < sentences.length; i++) {
    const previous = sentences[i - 1];
    if (!/\bbanked resets?\b/.test(previous) || !/\b(?:failed|not fully applying|didn't (?:work|apply)|affected|broken|issues?|outage)\b/.test(previous)) continue;
    if (/\b(?:if|unless|assuming|provided)\b/.test(sentences[i])) continue;
    // Resolve only an adjacent, explicit reissue with the recipient joined to the grant.
    // Do not carry a banked-reset topic through arbitrary text or unrelated objects.
    for (const part of clauses(sentences[i])) {
      if (assertion(part, BANKED_REPLACEMENT, true)) return true;
    }
  }
  return false;
}

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replaceAll('_', ' ')
    .replace(/\breseting\b/g, 'resetting').replace(/\breseted\b/g, 'reset').replace(/\breset's\b/g, 'reset is');
}

function classifyBody(text: string): Verdict {
  const t = normalize(text);
  const parts = clauses(t);
  const context = USAGE_CONTEXT.test(t);
  const banked = /\bbanked resets?\b/.test(t);
  // Mask technical reset phrases, retaining any separate usage reset in the same clause.
  const usable = parts.map(p => ({...p, text: p.text.replace(new RegExp(TECHNICAL_RESET.source, 'g'), '[technical operation]')}));

  if (hasBankedReplacement(t)) return verdict('BANKED_RESET', 'explicit reissue of failed banked resets to affected users');

  for (const part of usable) {
    const s = part.text;
    const grant = RESET.test(s) && context && /\b(?:grants?|eligib\w*|expir\w*|compensat\w*|promotional|distribut\w*)\b/.test(s);
    if ((/\bbanked resets?\b/.test(s) || grant) && assertion(part, BANKED_ACTION, true)
      && !/\bno (?:new )?banked resets?\b/.test(s)) {
      return verdict('BANKED_RESET', 'reset distribution, arrival, eligibility or expiry');
    }
  }

  for (const part of usable) {
    const s = part.text;
    if ((context || /\ball reset for everyone\b/.test(s)) && assertion(part, EXPLICIT_RESET, true)) {
      return verdict('RESET_ANNOUNCED', 'explicit announced or completed usage reset');
    }
    // @thsottiaux's standalone "Reset will land ..." is a deliberate MVP signal.
    if (assertion(part, RESET_DELIVERY, true) && (context || /^\s*(?:the |a |full |global )?reset\b/.test(s))) {
      return verdict('RESET_ANNOUNCED', 'reset arrival or completion confirmed');
    }
    if (RESET.test(t) && PRODUCT.test(t) && assertion(part, /\b(?:brand new|fresh) usage for all\b/, true)) {
      return verdict('RESET_ANNOUNCED', 'fresh usage for all users confirms a reset');
    }
  }

  for (const part of parts) {
    const s = part.text;
    const allowance = ALLOWANCE.test(s) || /\b(?:codex|chatgpt(?: work)?) limits?\b/.test(s)
      || (/\busage\b/.test(s) && /\b(?:subscriptions?|paid plans?)\b/.test(t));
    if (allowance && !TECHNICAL_LIMIT.test(s) && PRODUCT.test(t) && assertion(part, LIMIT_ACTION)) {
      return verdict('LIMIT_CHANGE', 'confirmed allowance, limit rule or subscription consumption change');
    }
  }
  // A newly introduced plan with an explicit exemption changes available quota rules.
  // Static comparisons such as "For clarity ... Pro has no 5h limits" stay below threshold.
  const newPlan = parts.some(p => assertion(p, /\b(?:introducing|launching|new (?:\w+ )?plan|designed for (?:teams|businesses|small companies))\b/));
  if (newPlan && PRODUCT.test(t) && parts.some(p => !p.question && !p.conditional
    && /(?:^\W*|\bwith |\boffers |\bincludes )(?:no|without) (?:5h|5[ -]hour|five[ -]hour|weekly) limits?\b/.test(p.text))) {
    return verdict('LIMIT_CHANGE', 'new plan announces an explicit allowance exemption');
  }

  for (const part of usable) {
    const s = part.text;
    if (/\bwho says\b/.test(s) && RESET.test(s) && (context || /\bin a while\b/.test(s))) {
      return verdict('RESET_HINT', 'rhetorical future reset tease');
    }
    const button = /\breset button\b/.test(t) && !TECHNICAL_RESET.test(t)
      && /\b(?:find|press|push|use|dust)\b/.test(s);
    if (!part.question && !DENIAL.test(s) && FORWARD.test(s)
      && ((RESET.test(s) && USAGE_CONTEXT.test(s)) || button)) {
      return verdict('RESET_HINT', 'forward-looking usage reset or reset-button hint');
    }
  }

  if (usable.some(p => RESET.test(p.text) && (context || banked || /\breset button\b/.test(p.text)))
    || parts.some(p => ALLOWANCE.test(p.text) && !TECHNICAL_LIMIT.test(p.text))) {
    return verdict('CANDIDATE', 'possible usage signal without a confirmed change or strong hint');
  }
  return verdict('IRRELEVANT', 'no usage reset or material allowance signal');
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\n+/).map(s => s.trim()).filter(Boolean);
}

function changeIn(text: string, relatedReset: boolean): {change: NonNullable<Verdict['change']>; evidence: string} | undefined {
  const originals = sentences(text);
  for (const [index, sentence] of originals.entries()) {
    const s = normalize(sentence);
    if (s.endsWith('?')) continue;
    const adjacentReset = index > 0 && RESET.test(normalize(originals[index - 1]))
      && /^(?:(?:cancelled|canceled|postponed|delayed)(?: (?:it|the reset|for now))?[.!]?$|(?:moved to|correction:|corrected to|meant|make that)\s+(?:\d|tomorrow|tonight|today|next|midnight|noon|monday|tuesday|wednesday|thursday|friday|saturday|sunday))/.test(s);
    if (!RESET.test(s) && !relatedReset && !adjacentReset) continue;
    const cancelled = /\b(?:cancel(?:led|ed|ling|ing)?|called off)\b/.exec(s);
    const postponed = /\b(?:postpon(?:e|ed|ing)|delay(?:ed|ing)?|reschedul(?:e|ed|ing)|push(?:ed|ing)? back|mov(?:e|ed|ing) (?:it |the reset )?to)\b/.exec(s);
    if (cancelled || postponed) {
      const match = cancelled ?? postponed!;
      if (!DENIAL.test(s.slice(0, match.index)) && !UNCERTAIN.test(s.slice(0, match.index))
        && !GENERAL_DISCUSSION.test(s.slice(0, match.index)))
        return {change: cancelled ? 'cancelled' : 'postponed', evidence: sentence};
      continue;
    }
    if (/\b(?:correction|corrected|correcting|typo|meant\s+\d|make that\s+\d)\b/.test(s)) return {change: 'corrected', evidence: sentence};
    if (!/\bwho says\b/.test(s) && /\b(?:no|not|never) (?:new |more |another )?(?:usage )?resets?\b|\breset\b.{0,35}\b(?:won't|will not|isn't|is not|not happening|no longer)\b|\b(?:won't|will not|don't|do not|not going to|no plans to|can't|cannot) (?:\w+\s+){0,5}reset\b/.test(s)) return {change: 'denied', evidence: sentence};
  }
  return undefined;
}

function ownEvidence(text: string, classification: Classification): string {
  const originals = sentences(text);
  if (classification === 'BANKED_RESET') {
    const replacement = originals.find(s => BANKED_REPLACEMENT.test(normalize(s)));
    if (replacement) return replacement;
  }
  if (classification === 'RESET_ANNOUNCED') {
    const explicit = originals.find(s => clauses(normalize(s)).some(p =>
      assertion(p, EXPLICIT_RESET, true) || assertion(p, RESET_DELIVERY, true)));
    if (explicit) return explicit;
  }
  return originals.find(s => RESET.test(normalize(s))) ?? originals[0] ?? text.trim();
}

// Receiving a notification and treating its content as a confirmed announcement are
// separate decisions. A literal reset mention is enough for an advisory from this author.
export function classify(text: string, related: RelatedPost[] = []): Verdict {
  const t = normalize(text);
  const ownReset = RESET.test(t);
  const relatedReset = related.some(post => typeof post.text === 'string' && RESET.test(normalize(post.text)));
  const body = classifyBody(text);
  if (ownReset) {
    const change = changeIn(text, false);
    if (change) return {classification: 'CANDIDATE', notify: true, display: 'advisory', ...change, reason: 'author reset update; timing or availability is not a confirmed new grant'};
    let display: NonNullable<Verdict['display']> = 'advisory';
    if (body.classification === 'RESET_ANNOUNCED') display = 'announcement';
    if (body.classification === 'BANKED_RESET') {
      // Eligibility, expiry and general banked-reset discussion still notify, but
      // announcement styling is reserved for an asserted distribution or arrival.
      const distribution = /\b(?:credit(?:ed|ing)?|giv(?:e|es|ing)|gave|grant(?:s|ed|ing)?|distribut(?:e|es|ed|ing)|receiv(?:e|es|ed|ing)|(?:(?:is|are|will be) getting|will get) (?:(?:a|one|another|an additional|[1-9]\d*) )?banked resets?|land(?:s|ed|ing)?|arriv(?:e|es|ed|ing)|roll(?:s|ed|ing)? out|will be there|covered with|do the (?:full )?banked reset)\b/;
      if (hasBankedReplacement(t) || clauses(t).some(p => /\bbanked resets?\b/.test(p.text) && assertion(p, distribution, true))) display = 'announcement';
    }
    return {...body, classification: ['IRRELEVANT', 'LIMIT_CHANGE'].includes(body.classification) ? 'CANDIDATE' : body.classification,
      notify: true, display, evidence: ownEvidence(text, body.classification),
      reason: display === 'announcement' ? body.reason : 'author mentions reset; advisory does not confirm a reset or its timing'};
  }
  if (relatedReset) {
    return {classification: 'CANDIDATE', notify: true, display: 'advisory',
      reason: 'author reply or quote refers to related reset content; related text is not an author announcement',
      evidence: text.trim(), ...changeIn(text, true)};
  }
  const mushroomDistribution = /🍄|\bmushrooms?\b/.test(t) && clauses(t).some(p =>
    /🍄|\bmushrooms?\b/.test(p.text) && /\b(?:everyone|all users|all paid users|paid users|subscribers?|accounts?|codex|chatgpt)\b/.test(p.text)
    && assertion(p, /\b(?:giv(?:e|ing)|grant(?:ing)?|distribut(?:e|ing)|(?:is|are|will be) getting|will get)\b/, true));
  if (mushroomDistribution) return {classification: 'BANKED_RESET', notify: true,
    display: PRODUCT.test(t) ? 'announcement' : 'advisory',
    reason: 'author explicitly distributes mushrooms; product context determines announcement certainty',
    evidence: sentences(text).find(s => /🍄|\bmushrooms?\b/.test(normalize(s))) ?? text.trim()};
  return {...body, ...(body.classification === 'LIMIT_CHANGE' ? {display: 'limit' as const} : {}), evidence: ownEvidence(text, body.classification)};
}

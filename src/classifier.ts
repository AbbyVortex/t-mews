import type { Classification, Verdict } from './types';

const RESET = /\breset(?:s|ting)?\b/;
const PRODUCT = /\b(?:codex|chatgpt(?:\s*work)?|paid|plus|pro|business|subscriptions?|plans?)\b/;
const USAGE_CONTEXT = /\b(?:codex|chatgpt\s*work|usage|limits?|quota|allowance|subscriptions?|paid users?)\b/;
const ALLOWANCE = /\b(?:(?:usage|rate) limits?|(?:weekly|5h|5[ -]hour|five[ -]hour) (?:codex |chatgpt(?: work)? )?(?:usage )?limits?|weekly (?:usage|allowance)|quotas?|allowances?|usage (?:consumption|allocation))\b/;
const TECHNICAL_RESET = /\b(?:password|branch|cache|database|connection|counter|git|session|repository|router|server|device|layout|workspace|project)(?:s)?\s+reset\b|\breset(?:ting)? (?:the |a |your |my )?(?:usage counters?|passwords?|branches?|cache|database|connection|counter|git|session|repository|router|server|device|(?:ui )?layout|settings|workspace|project)\b/;
const TECHNICAL_LIMIT = /\b(?:context(?: window)?|memory|speed|throughput|hardware|recursion|stack|storage|disk|concurrency|payload|api) (?:usage|limits?|quota)\b|\blimits? of (?:the )?model speed\b/;
const FORWARD = /\b(?:soon|tomorrow|tonight|today|later|around|in a while|next|this (?:morning|evening|week)|at \d|by \d|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{4}-\d{2}-\d{2})\b|👀/;
const DENIAL = /\b(?:not|never|no|won't|will not|can't|cannot|don't|doesn't|didn't|haven't|hasn't|isn't|aren't|wasn't|weren't)\b/;
const UNCERTAIN = /\b(?:if|might|maybe|could|perhaps|may|would|should|please|hoping|hope|can you)\b/;

// Match the assertion itself. Qualifiers after it (e.g. grant eligibility) do not veto it.
const EXPLICIT_RESET = /\b(?:reset(?:ting)? (?:the |your |my |all |everyone's )?(?:codex (?:and chatgpt work )?)?(?:usage(?: limits?)?|limits?|quotas?|allowances?)|(?:full|global) reset (?:of )?(?:the )?(?:usage|limits?|quota|allowance)|(?:limits?|usage|quota|allowance) (?:will (?:be )?|(?:has|have) (?:now )?been |(?:is|are) being |(?:is|are|was|were) (?:now )?)reset|all reset for everyone)\b/;
const RESET_DELIVERY = /\breset (?:will (?:land|arrive)|(?:has|have) (?:now )?(?:landed|arrived)|(?:has|have) been propagated|is (?:landing|rolling out))\b/;
const BANKED_ACTION = /\b(?:credit(?:ed|ing)?|giv(?:e|es|ing)|gave|grant(?:s|ed|ing)?|distribut(?:e|es|ed|ing)|receiv(?:e|es|ed|ing)|land(?:s|ed|ing)?|arriv(?:e|es|ed|ing)|roll(?:s|ed|ing)? out|no longer (?:available|eligible|valid)|available|expir(?:e|es|ed|ing)|extend(?:s|ed|ing)?|compensat\w*|promotional|eligible|eligibility (?:now )?(?:includes|excludes|changes|has changed)|will be there|covered with|do the (?:full )?banked reset)\b/;
const LIMIT_ACTION = /\b(?:increas\w*|decreas\w*|doubl\w*|tripl\w*|reduc\w*|rais\w*|lower\w*|chang(?:e|es|ed|ing)|boost\w*|bring(?:ing)? back|brought back|reintroduc\w*|remov\w*|lift(?:ed|ing)?|disabl\w*|enabl\w*|no longer (?:have|has|apply|applies|enforce|enforces|enabled|required)|(?:is|are) now \d+(?:\.\d+)?\s*(?:x|%)|(?:more|less|fewer) usage|usage.{0,35}(?:further|faster|slower))\b/;

interface Clause { text: string; question: boolean; conditional: boolean }

function clauses(text: string): Clause[] {
  // Keep question scope, but isolate unrelated sentences and coordinated claims.
  return text.split(/(?<=[.!?;])\s+|\n+/).flatMap(sentence =>
    sentence.split(/,|\s+(?:but|however|and(?=\s+(?:we|i|you|they|a|an|the|it)\b))\s+/)
      .map(part => ({text: part.trim(), question: sentence.endsWith('?'), conditional: /^\s*(?:if|unless|assuming|provided)\b/.test(sentence)}))
  );
}

function assertion(clause: Clause, pattern: RegExp): boolean {
  if (clause.question || clause.conditional) return false;
  for (const match of clause.text.matchAll(new RegExp(pattern.source, 'g'))) {
    const prefix = clause.text.slice(0, match.index);
    if (!DENIAL.test(prefix) && !UNCERTAIN.test(prefix)) return true;
  }
  return false;
}

function verdict(classification: Classification, reason: string): Verdict {
  return {classification, notify: !['CANDIDATE', 'IRRELEVANT'].includes(classification), reason};
}

export function classify(text: string): Verdict {
  const t = text.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'")
    .replace(/\breseting\b/g, 'resetting').replace(/\breseted\b/g, 'reset');
  const parts = clauses(t);
  const context = USAGE_CONTEXT.test(t);
  const banked = /\bbanked resets?\b/.test(t);
  // Mask technical reset phrases, retaining any separate usage reset in the same clause.
  const usable = parts.map(p => ({...p, text: p.text.replace(new RegExp(TECHNICAL_RESET.source, 'g'), '[technical operation]')}));

  for (const part of usable) {
    const s = part.text;
    const grant = RESET.test(s) && context && /\b(?:grants?|eligib\w*|expir\w*|compensat\w*|promotional|distribut\w*)\b/.test(s);
    if ((/\bbanked resets?\b/.test(s) || grant) && assertion(part, BANKED_ACTION)
      && !/\bno (?:new )?banked resets?\b/.test(s)) {
      return verdict('BANKED_RESET', 'reset distribution, arrival, eligibility or expiry');
    }
  }

  for (const part of usable) {
    const s = part.text;
    if ((context || /\ball reset for everyone\b/.test(s)) && assertion(part, EXPLICIT_RESET)) {
      return verdict('RESET_ANNOUNCED', 'explicit announced or completed usage reset');
    }
    // @thsottiaux's standalone "Reset will land ..." is a deliberate MVP signal.
    if (assertion(part, RESET_DELIVERY) && (context || /^\s*(?:the |a |full |global )?reset\b/.test(s))) {
      return verdict('RESET_ANNOUNCED', 'reset arrival or completion confirmed');
    }
    if (RESET.test(t) && PRODUCT.test(t) && assertion(part, /\b(?:brand new|fresh) usage for all\b/)) {
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

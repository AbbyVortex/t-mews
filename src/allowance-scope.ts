export type AllowanceScope = 'included' | 'excluded' | 'unknown' | 'not_applicable';

const PLAN = /\b(?:pro[ -]?[1-9]\d*\b|prolite\b|pro\s*\(\s*\$\s*\d+\s*\)|plus\b|pro\b|business\b|enterprise\b|edu\b|free\b|go\b)|\$\s*\d+\b/g;
const CHANGE = /\b(?:increas\w*|decreas\w*|doubl\w*|tripl\w*|reduc\w*|rais\w*|lower\w*|chang(?:e|es|ed|ing)|boost\w*|remov\w*|lift\w*|introduc\w*|launch\w*|bring\w* back|brought back|reintroduc\w*|reinstat\w*|exempt\w*|no longer|no (?:5h|weekly)|more usage|less usage|(?:is|are) now \d+(?:\.\d+)?\s*(?:x|%))\b/;

/** Only explicit affected recipients can suppress the immediate mechanical alert. */
export function allowanceScope(text: string): AllowanceScope {
 const normalized = text.normalize('NFKC').toLowerCase()
  .replace(/\bpro\s*(?:\(\s*)?\$\s*(\d+)(?:\s*\/\s*(?:mo(?:nth)?))?\s*\)?|\$\s*(\d+)\s+pro\b/g, (_, before, after) => 'pro '+(before??after));
 const claims = normalized.split(/(?<=[.!?;])\s+|\n+|\s+(?:but|while|whereas)\s+/)
  .map(claim => claim.replace(/\b(?:unlike|compared (?:with|to)|in comparison (?:with|to))\b[^,;.!?]*(?:,|(?=[;.!?]|$))/g,
   comparison => CHANGE.test(comparison) ? comparison : '')
   .replace(/,\s*(?:plus|pro[ -]?\d+|prolite)\b[^,.!?]*\b(?:unchanged|same)\b[^,.!?]*/g, ''))
  .filter(claim => CHANGE.test(claim) && !/\b(?:unchanged|not changing|no changes?|stays? the same)\b/.test(claim));
 if (!claims.length) return 'unknown';
 const scopes = claims.map(claim => {
  // A change to everyone or an unspecified Pro tier might affect the user's plans.
  if (/\b(?:all (?:plans?|tiers?|users?|subscribers?)|everyone|across (?:all )?(?:plans?|tiers?))\b/.test(claim)) return 'unknown';
  const plans = [...claim.matchAll(PLAN)].map(match => match[0]);
  const namedPlan = /\b(?:only )?([a-z][a-z0-9-]*) plan\b/.exec(claim);
  if (!plans.length && namedPlan && !['all','paid','new','our','the','current','existing','every'].includes(namedPlan[1])
   && /^(?:(?:we (?:are )?)?(?:introducing|launching) (?:a |the )?(?:new )?)?(?:codex |chatgpt )?(?:only )?$|\b(?:for|to|on|of) (?:only )?$/.test(claim.slice(0,namedPlan.index))) return 'excluded';
  if (!plans.length) return 'unknown';
  if (plans.some(plan => /^(?:plus|prolite|pro[ -]?100)$|\$\s*(?:20|100)\b/.test(plan))) return 'included';
  if (plans.includes('pro')) return 'unknown';
  if (/\b(?:not|except|excluding|rather than|instead of)\b/.test(claim)) return 'unknown';
  // Resolve only subject/recipient statements. A bare plan mention elsewhere is insufficient.
  const recipients = /^(?:(?:(?:we|i) (?:are |am |will be )?)?(?:introducing|launching) (?:a |the )?(?:new )?)?(?:the )?(?:chatgpt |codex )?(?:\$\s*\d+\s*(?:\/\s*month\s*)?(?:pro\s*)?|pro[ -]?[1-9]\d*|pro\s*\(\s*\$\s*\d+\s*\)|business|enterprise|edu|free|go)\b/.test(claim.trim())
   || /\b(?:for|to|on|of|affects?|affecting|available (?:to|on))\s+(?:only\s+)?(?:the\s+)?(?:chatgpt\s+|codex\s+)?(?:pro[ -]?[1-9]\d*|pro\s*\(\s*\$\s*\d+\s*\)|\$\s*\d+|business|enterprise|edu|free|go)\b/.test(claim);
  return recipients ? 'excluded' : 'unknown';
 });
 if (scopes.includes('included')) return 'included';
 return scopes.every(scope => scope === 'excluded') ? 'excluded' : 'unknown';
}

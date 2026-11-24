import test from 'node:test';
import assert from 'node:assert/strict';
import {classify} from '../src/classifier';
import {allowanceScope} from '../src/allowance-scope';
import {isCriticalMachine,planLiveNotification} from '../src/ai-live-policy';
import type {LiveResult} from '../src/ai-live-classifier';

const examples = [
 ['We doubled Codex weekly limits for Plus.', 'included'],
 ['Pro 100 now has doubled Codex usage limits.', 'included'],
 ['We increased Codex usage limits for prolite.', 'included'],
 ['We doubled Codex weekly limits for Pro ($100).', 'included'],
 ['We doubled Codex weekly limits for Pro 200 and Plus.', 'included'],
 ['We doubled Codex usage limits for Pro 200.', 'excluded'],
 ['Pro 500 Codex weekly limits have doubled.', 'excluded'],
 ['Pro 300 Codex weekly limits have doubled.', 'excluded'],
 ['We doubled Codex usage limits for Pro $200.', 'excluded'],
 ['Business and Enterprise now have doubled Codex weekly limits.', 'excluded'],
 ['Free, Go and Edu have doubled Codex weekly limits.', 'excluded'],
 ['Should we double Codex usage limits for Business?', 'excluded'],
 ['Introducing a new Enterprise plan for Codex with no 5h limits.', 'excluded'],
 ['Codex weekly limits are now 5x for Pro 200.', 'excluded'],
 ['Only Starter plan users get doubled Codex weekly limits.', 'excluded'],
 ['Pro 200 limits doubled, Plus stays unchanged.', 'excluded'],
 ['Plus remains unchanged. Pro 200 Codex limits doubled.', 'excluded'],
 ['We doubled Codex usage limits for Pro.', 'unknown'],
 ['We doubled Codex usage limits for all plans.', 'unknown'],
 ['We doubled Codex usage limits.', 'unknown'],
 ['Unlike Pro 200, Plus now has doubled Codex weekly limits.', 'included'],
 ['Pro 200 has higher Codex limits. We doubled Codex weekly limits for Plus.', 'included'],
 ['Pro 200 has higher limits. We doubled Codex weekly limits.', 'unknown'],
 ['Pro 200 Codex weekly limits doubled, compared to Plus.', 'excluded'],
 ['Pro 200 Codex limits doubled, compared to Plus whose quota also increased.', 'included'],
] as const;
for (const [text,scope] of examples) test('allowance recipients: '+text,()=>{
 assert.equal(allowanceScope(text),scope);
 const verdict=classify(text);
 if(verdict.classification==='LIMIT_CHANGE'){
  assert.equal(verdict.notify,scope!=='excluded');
  assert.equal(isCriticalMachine(verdict),scope!=='excluded');
 }
});

test('reply and comparison plans do not override the author audience; independent reset value bypasses filtering',()=>{
 const related=[{relation:'reply' as const,xStatusId:'1',url:'https://x.com/thsottiaux/status/1',text:'Pro 200 limits doubled.',provenance:'feed' as const}];
 assert.equal(classify('We doubled Codex limits for Plus.',related).notify,true);
 for(const text of ['We doubled Codex limits for Enterprise. Resetting the usage limits tomorrow.',
  'Pro 200 limits doubled. Who says it will not reset in a while 👀',
  'Enterprise usage limits doubled. A banked reset will be distributed to paid users.',
  'Business limits doubled. We are giving mushrooms to all paid Codex users.']){
  assert.equal(classify(text).notify,true,text);
  assert.equal(classify(text).allowanceScope,undefined,text);
 }
 assert.equal(classify('Pro 200 Codex limits doubled.',[{...related[0],text:'A reset is coming.'}]).notify,true);
});

test('excluded allowance-only AI decisions are silent across normal, diagnostic and fallback paths',()=>{
 const excluded=classify('Codex usage limits doubled for Pro 200.');
 const unknown=classify('Codex usage limits doubled for Pro.');
 for(const category of ['limit_change','attention','chatter','unrelated'] as const){
  const result:LiveResult={category,allowanceScope:'excluded',rationale:'Pro 200だけへの変更。',confidence:1,uncertainty:''};
  assert.equal(planLiveNotification(excluded,result,false),undefined);
  assert.equal(planLiveNotification(unknown,result,true),undefined,'no follow-up diagnostic after an ambiguous immediate alert');
 }
 assert.equal(planLiveNotification(excluded,undefined,false,'timeout'),undefined);
 const reset=classify('Enterprise usage doubled. Resetting the usage limits tomorrow.');
 const result:LiveResult={category:'attention',allowanceScope:'excluded',rationale:'fixture',confidence:1,uncertainty:''};
 assert.ok(planLiveNotification(reset,result,false),'independent machine Reset value is preserved');
 assert.ok(planLiveNotification(excluded,{...result,allowanceScope:'not_applicable'},false),'AI can find independent reset reaction');
});

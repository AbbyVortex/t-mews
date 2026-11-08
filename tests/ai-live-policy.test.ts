import test from 'node:test';
import assert from 'node:assert/strict';
import {classify} from '../src/classifier';
import {formatLiveNotification,isCriticalMachine,planLiveNotification} from '../src/ai-live-policy';
import type {LiveResult} from '../src/ai-live-classifier';
import type {Item,Verdict} from '../src/types';

const ai=(category:LiveResult['category']):LiveResult=>({category,rationale:'対象の投稿と取得済み文脈から判定。',confidence:.9,uncertainty:''});
const irrelevant:Verdict={classification:'IRRELEVANT',notify:false,reason:'unrelated'};
const candidate:Verdict={classification:'CANDIDATE',notify:true,display:'advisory',reason:'reset keyword'};
const announced:Verdict={classification:'RESET_ANNOUNCED',notify:true,display:'announcement',reason:'explicit'};
const limit:Verdict={classification:'LIMIT_CHANGE',notify:true,display:'limit',reason:'explicit'};
const post:Item={id:'x:2',xStatusId:'2',url:'https://x.com/thsottiaux/status/2',fingerprint:'fixture',publishedAt:Date.parse('2026-11-08T00:00:00Z')/1000,
 text:'We will reset usage on 2026-11-09 at 12:00 PM UTC.',kind:'post',source:'fxtwitter'};

test('effective agreement preserves one ordinary attention notice or no notice without inventing mismatches',()=>{
 assert.deepEqual(planLiveNotification(candidate,ai('attention'),false),{kind:'normal',mismatch:false,priority:0});
 for(const category of ['unrelated','chatter'] as const)assert.equal(planLiveNotification(irrelevant,ai(category),false),undefined);
 assert.equal(planLiveNotification(announced,ai('announcement'),true),undefined);
 assert.equal(planLiveNotification(limit,ai('limit_change'),true),undefined);
});

test('AI-only discoveries and importance changes produce one combined decision notice',()=>{
 const cases:[Verdict,LiveResult['category'],-1|0|1][]=[
  [irrelevant,'announcement',1],[irrelevant,'attention',0],[irrelevant,'limit_change',0],
  [candidate,'announcement',1],[candidate,'limit_change',0],
  [announced,'attention',0],[limit,'announcement',1],[announced,'limit_change',0],
 ];
 for(const [machine,category,priority] of cases){
  const plan=planLiveNotification(machine,ai(category),false)!;
  assert.deepEqual(plan,{kind:'normal',mismatch:true,priority});
  const rendered=formatLiveNotification(post,machine,ai(category),plan,25);
  assert.match(rendered.title,/判定不一致/);assert.ok(rendered.message.includes(machine.classification));
  assert.ok(rendered.message.includes(category));assert.ok(rendered.message.includes(post.url!));
 }
});

test('Nov 8 product-design chatter suppresses the ordinary Candidate alarm but retains a quiet diagnostic',()=>{
 const text='@ForwardEditor We hesitated to embed https://x.com into the codex app to make sense of the resets, but decided against it.';
 const machine=classify(text);assert.equal(machine.classification,'CANDIDATE');assert.equal(machine.notify,true);
 const result={...ai('chatter'),rationale:'Resetを理解しやすくする製品案の雑談で、配布や新しい利用枠情報ではない。'};
 const plan=planLiveNotification(machine,result,false)!;
 assert.deepEqual(plan,{kind:'diagnostic',mismatch:true,priority:-1});
 const rendered=formatLiveNotification({...post,id:'x:2119308687676432672',text},machine,result,plan,387);
 assert.equal(rendered.title,'🔎 判定不一致');assert.match(rendered.message,/CANDIDATE/);assert.match(rendered.message,/雑談・通知価値なし/);
 assert.deepEqual(planLiveNotification(candidate,ai('unrelated'),false),plan);
});

test('critical machine grants and allowance changes are immediate, while corrections stay noncritical',()=>{
 for(const text of ['Banked 1/2','Day 28/ Banked 2/2','We will reset usage for all paid users tomorrow.'])assert.equal(isCriticalMachine(classify(text)),true,text);
 assert.equal(isCriticalMachine(limit),true);assert.equal(isCriticalMachine(candidate),false);
 assert.equal(isCriticalMachine({...announced,display:'advisory',change:'postponed'}),false);
 assert.equal(isCriticalMachine({...limit,display:'advisory'}),false);
 assert.equal(isCriticalMachine({...announced,notify:false}),false);
});

test('an already delivered critical alert gets only a low-priority disagreement follow-up',()=>{
 for(const [machine,category] of [[announced,'attention'],[announced,'chatter'],[announced,'unrelated'],[limit,'announcement'],[limit,'attention'],[announced,'limit_change']] as const){
  assert.deepEqual(planLiveNotification(machine,ai(category),true),{kind:'diagnostic',mismatch:true,priority:-1});
 }
 assert.equal(planLiveNotification(announced,undefined,true,'timeout'),undefined);
 assert.equal(planLiveNotification(candidate,ai('announcement'),true),undefined,'do not add follow-up after noncritical fallback');
});

test('unavailable AI uses the machine priority and records failure without claiming a disagreement',()=>{
 for(const [machine,priority] of [[announced,1],[classify('Banked 1/2'),0],[limit,0],[candidate,0]] as const){
  const plan=planLiveNotification(machine,undefined,false,'quota_or_rate_limit')!;
  assert.deepEqual(plan,{kind:'fallback',mismatch:false,priority});
  const rendered=formatLiveNotification(post,machine,undefined,plan,30,'quota_or_rate_limit');
  assert.match(rendered.title,/AI unavailable/);assert.match(rendered.message,/AI unavailable: quota_or_rate_limit/);
  assert.ok(!rendered.title.includes('判定不一致'));assert.ok(!rendered.message.includes('判定不一致'));
 }
 assert.equal(planLiveNotification(irrelevant,undefined,false,'timeout'),undefined);
 const plan=planLiveNotification(candidate,undefined,false)!;
 assert.ok(!formatLiveNotification(post,candidate,undefined,plan,null,'raw-secret-value').message.includes('raw-secret-value'));
});

test('Pushover comparisons fit character limits, retain URL/Japanese clock conversion and preserve inputs',()=>{
 const result={...ai('announcement'),rationale:'🍄'.repeat(240),uncertainty:'不明'.repeat(120)};
 const source={...post,text:post.text+' '+('本文🍄'.repeat(500))};const before=structuredClone({source,result,machine:candidate});
 const plan=planLiveNotification(candidate,result,false)!;
 const rendered=formatLiveNotification(source,candidate,result,plan,387);
 assert.ok([...rendered.title].length<=250);assert.ok([...rendered.message].length<=1024);
 assert.match(rendered.message,/🛠機械: 🍄 CANDIDATE/);assert.match(rendered.message,/🤖AI: 💣/);
 assert.ok(rendered.message.endsWith(post.url!));assert.match(rendered.message,/JST/);
 assert.deepEqual({source,result,machine:candidate},before);
 const ordinary=formatLiveNotification(post,announced,ai('announcement'),planLiveNotification(announced,ai('announcement'),false)!,0);
 assert.match(ordinary.message,/日本時間/);assert.match(ordinary.message,/21:00/);
});

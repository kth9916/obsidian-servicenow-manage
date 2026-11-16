const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('main.js', 'utf8');
const block = source.split('// BEGIN TRANSLATION BUDGET')[1].split('// END TRANSLATION BUDGET')[0];
const ctx = vm.createContext({ Intl, Date, Notice: class {}, PLUGIN_ID: 'test' });
vm.runInContext(block + '\nthis.Budget=TranslationBudget;this.count=translationCharacterCount;', ctx);
function fixture() {
  const files = new Map(), notices = [];
  let date = new Date('2026-11-16T00:00:00Z'), fail = false, calls = 0;
  const adapter = { exists: async p => files.has(p), read: async p => files.get(p), write: async(p,v) => { if(fail) throw Error('disk'); files.set(p,v); } };
  const plugin = { manifest: {dir:'plugin'}, app:{vault:{adapter,configDir:'.obsidian'}} };
  const create = () => new ctx.Budget(plugin, () => date, m => notices.push(m));
  const budget = create(), api = {translate: async text => {calls++;return {status_code:200,translation:text};}};
  return {budget,api,files,notices,create,setDate:d=>date=new Date(d),fail:()=>fail=true,calls:()=>calls};
}
async function ready(f, limit=10) {await f.budget.summary();await f.budget.setBaseline(0,'2026-11');await f.budget.configure(limit,80);}
(async()=>{
  assert.equal(ctx.count('A😀한\n '),5);
  let f=fixture();await assert.rejects(f.budget.translate(f.api,'a','auto','ko'));assert.equal(f.calls(),0);
  await ready(f);
  await f.budget.translate(f.api,'12345678','auto','ko');assert.equal(f.notices.filter(n=>n.includes('도달')).length,1);
  await f.budget.translate(f.api,'12','auto','ko');
  await assert.rejects(f.budget.translate(f.api,'a','auto','ko'));assert.equal(f.calls(),2);
  assert.equal((await f.create().summary()).total,10);
  await f.budget.setBaseline(1,'2026-11');assert.equal((await f.budget.summary()).used,10);
  f.setDate('2026-11-30T15:00:00Z');assert.equal((await f.budget.summary()).total,0);assert.equal((await f.budget.summary()).month,'2026-12');
  await assert.rejects(f.budget.setBaseline(0,'2026-11'));
  f.setDate('2026-11-29T00:00:00Z');await assert.rejects(f.budget.summary());
  f=fixture();await ready(f);
  const results=await Promise.allSettled(Array.from({length:10},()=>f.budget.translate(f.api,'abc','auto','ko')));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,3);assert.equal(f.calls(),3);assert.equal((await f.budget.summary()).used,9);
  f=fixture();await ready(f);
  await assert.rejects(f.budget.translate({translate:async()=>{throw Error('timeout');}},'abc','auto','ko'));
  assert.equal((await f.budget.summary()).used,3);
  await f.budget.translate({translate:async()=>({status_code:500})},'ab','auto','ko');assert.equal((await f.budget.summary()).used,5);
  await f.budget.translate(f.api,'abc','ko','ko');assert.equal((await f.budget.summary()).used,5);
  for(const value of [NaN,-1,0,1.5,Infinity])await assert.rejects(f.budget.configure(value,80));
  f.fail();await assert.rejects(f.budget.translate(f.api,'a','auto','ko'));assert.equal(f.calls(),0);
  f=fixture();await ready(f);f.files.set('plugin/translation-usage.json','broken');await assert.rejects(f.create().translate(f.api,'a','auto','ko'));assert.equal(f.calls(),0);
  f.files.delete('plugin/translation-usage.json');await assert.rejects(f.create().summary());
  assert.equal((source.match(/await this\.translateWithBudget\(/g)||[]).length,3);
  assert.equal((source.match(/return api\.translate\(text,source,target\)/g)||[]).length,1);
  console.log('Translation budget: limits, concurrency, persistence, rollover, failures and routing passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});

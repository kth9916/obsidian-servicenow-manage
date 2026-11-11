const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const method = name => {
  const start = source.search(new RegExp('^  (?:async )?'+name+'\\(', 'm'));
  assert(start >= 0, name); const rest = source.slice(start), end = rest.slice(1).search(/\n  (?:async )?\w+\(/);
  return rest.slice(0, end+1).trim();
};
let now = 1_800_000_000_000;
const notices = [], errors = [];
const methods = new Function('normalizeTicketId','localIsoDateTime','Notice','Date','console','mergeEntries', 'return {'+['syncTicket','performTicketSync','syncAllTickets','retryFailedTickets','runCatchUpSync','syncUninitializedTickets'].map(method).join(',')+'}')(value=>/^((CR|SR|INC)\d+)$/.test(value)?value:'',()=>new Date(now).toISOString(),class {constructor(message){notices.push(message)}},{now:()=>now},{warn:(...args)=>errors.push(args),error:(...args)=>errors.push(args)},(...entries)=>entries.flat());
const id = 'CR0000000';
function fixture() {
  let calls = 0, fail = false, gate = null;
  const p = {...methods, settings:{autoSync:true}, data:{tickets:{}}, syncing:new Set(), ticketSyncJobs:new Map(), syncDisposed:false,
    refreshViews(){}, rootTicketFiles:()=>[id], activeRootTicketFiles:()=>[id],rootTicketIdFromFile:x=>x,getTicketActivity:()=>({kind:'active'}),
    async fetchTicket(){calls++; if(gate)await gate; if(fail)throw Error('Example network failure');return {ticketId:id,entries:[],warnings:[],lastSyncedAt:new Date(now).toISOString()};},
    persistTicketAttachmentImages:async()=>{},persistTicketAttachmentVideos:async()=>{},updateTicketMetadata:async()=>{},applyTicketState:async()=>{},updateTicketServiceNowLink:async()=>{},findLocalTicketDocument:()=>null,updateWorkNotesFrontMatter:async()=>{},savePluginData:async()=>{p.saved=JSON.parse(JSON.stringify(p.data));}};
  return {p,calls:()=>calls,fail:value=>fail=value,gate:value=>gate=value};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  const f=fixture(); let release;f.gate(new Promise(resolve=>release=resolve));
  const first=f.p.syncTicket(id), batch=f.p.syncAllTickets({activeOnly:true});await tick();
  assert.equal(f.calls(),1,'overlapping startup/daily requests share one actual fetch');release();
  const [result,summary]=await Promise.all([first,batch]);assert(result);assert.equal(summary.completed,1);assert.equal(summary.failed,0);assert.equal(f.p.ticketSyncJobs.size,0);
  f.gate(null);f.fail(true);assert.equal(await f.p.syncTicket(id),null);
  assert.equal(f.p.data.tickets[id].syncRetry.attempt,0);assert.equal(f.p.data.tickets[id].syncRetry.nextAt,now+60000);
  assert(result.lastSyncedAt===f.p.data.tickets[id].lastSyncedAt,'failure preserves prior success data');
  const initialCalls=f.calls();await f.p.retryFailedTickets();assert.equal(f.calls(),initialCalls,'no premature retries');
  for(const [wait,attempt,nextDelay] of [[60000,1,300000],[300000,2,900000],[900000,3,null]]){
    now+=wait;await f.p.retryFailedTickets();const retry=f.p.data.tickets[id].syncRetry;
    assert.equal(retry.attempt,attempt);assert.equal(retry.nextAt,nextDelay?now+nextDelay:null);
  }
  const capped=f.calls();now+=3600000;await f.p.retryFailedTickets();assert.equal(f.calls(),capped,'three retries only');
  assert.equal(f.p.data.tickets[id].syncFailureHistory.length,4);
  assert(notices.some(text=>text.includes('자동 재시도 종료')));
  f.fail(false);await f.p.syncTicket(id);assert.equal(f.p.data.tickets[id].lastError,undefined);assert.equal(f.p.data.tickets[id].syncRetry,null);
  assert.equal(f.p.data.tickets[id].syncFailureHistory.length,4,'history survives recovery');
  const successCalls=f.calls();now+=3600000;await f.p.retryFailedTickets();assert.equal(f.calls(),successCalls,'no retries after recovery');
  f.fail(true);await f.p.syncTicket(id);assert.equal(f.p.data.tickets[id].syncRetry.attempt,0,'explicit/next scheduled run starts a new bounded cycle');
  const restarted=fixture();restarted.p.data=JSON.parse(JSON.stringify(f.p.saved));now+=60000;await restarted.p.retryFailedTickets();assert.equal(restarted.calls(),1,'persisted due failures resume after restart');assert.equal(restarted.p.data.tickets[id].syncRetry,null);
  const startup=fixture();startup.fail(true);await startup.p.syncTicket(id);await startup.p.runCatchUpSync();await startup.p.syncUninitializedTickets();assert.equal(startup.calls(),1,'startup catch-up/initialization must not reset a persisted retry budget');
  const disabled=fixture();disabled.fail(true);await disabled.p.syncTicket(id);now+=60000;disabled.p.settings.autoSync=false;await disabled.p.retryFailedTickets();assert.equal(disabled.calls(),1,'automation disabled is respected');
  disabled.p.settings.autoSync=true;disabled.p.activeRootTicketFiles=()=>[];await disabled.p.retryFailedTickets();assert.equal(disabled.calls(),1,'archived/deleted notes are not retried');
  disabled.p.activeRootTicketFiles=()=>[id];disabled.p.syncDisposed=true;await disabled.p.retryFailedTickets();assert.equal(disabled.calls(),1,'no retries after unload');
  const overlap=fixture();overlap.fail(true);await overlap.p.syncTicket(id);now+=60000;
  let finish;overlap.gate(new Promise(resolve=>finish=resolve));const retry=overlap.p.retryFailedTickets();await tick();await overlap.p.retryFailedTickets();assert.equal(overlap.calls(),2,'timer reentry is coalesced');await overlap.p.savePluginData();assert(overlap.p.saved.tickets[id].lastError,'unrelated saves while retrying cannot erase the pending failure');finish();await retry;
  const local=fixture();local.fail(true);local.p.updateWorkNotesFrontMatter=async()=>{throw Error('Example local write failure')};await local.p.syncTicket(id);assert(local.p.saved.tickets[id].syncRetry,'failed status write cannot discard retry scheduling');
  const jira=fixture();jira.p.jiraWorkspace={queueSync:async()=>{throw Error('Jira unavailable')}};assert(await jira.p.syncTicket(id));assert.equal(jira.p.data.tickets[id].syncRetry,null,'Jira failure is not a ServiceNow failure');
  const skipped=fixture();skipped.p.syncDisposed=true;const skippedResult=await skipped.p.syncAllTickets();assert.equal(skippedResult.failed,0);assert.equal(skippedResult.deferred,1);
  for(let i=0;i<8;i++)await f.p.syncTicket(id);assert.equal(f.p.data.tickets[id].syncFailureHistory.length,5,'bounded history');
  assert(/async automationTick\(\)[\s\S]*?await this\.retryFailedTickets\(\)/.test(source));
  const fragment=source.slice(source.indexOf('    const statusText = ticket?.lastError'),source.indexOf('    const actions = header.createDiv',source.indexOf('    const statusText = ticket?.lastError')));
  const nodes=[],host={createDiv:options=>nodes.push(options),createEl:(_tag,options)=>{nodes.push(options);return host;}};
  new Function('ticket','headingBlock','localIsoDateTime',fragment)({lastSyncedAt:'Old success',lastError:'Current failure',syncRetry:{attempt:1,nextAt:now},syncFailureHistory:[{time:'Earlier',error:'Original failure'}]},host,()=> 'Next time');
  assert(nodes.some(n=>n?.text?.includes('Current failure')&&n.text.includes('2/3')),'current failure and next retry are visible even after an old success');
  assert(nodes.some(n=>n?.text==='Earlier · Original failure'),'failure history uses text-only elements');
  console.log('PASS sync retries: shared real outcomes, no false failures, 1/5/15-minute bounded retries, restart/recovery, preserved data/history, opt-out/inactive/unload, overlapping ticks, local save errors and Jira isolation. All I/O mocked.');
})().catch(error=>{console.error(error);process.exit(1)});

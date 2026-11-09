const fs=require('fs'),path=require('path'),assert=require('assert'),vm=require('vm');
const template=fs.readFileSync(path.join(__dirname,'jira-workspace-check.js'),'utf8');
const {fixture,api,ticket,context}=new Function('require','__dirname',template.slice(0,template.indexOf('(async()=>{'))+';return {fixture,api,ticket,context};')(require,__dirname);
// DOM serialization is exercised separately by the rendered browser fixture.
context.jiraCommentEditDocument=html=>({text:html,slots:[]});context.jiraComposeMentions=async(_p,text)=>'<p>'+text+'</p>';
let count=0;const check=(v,m)=>{count++;assert(v,m)};
async function ready(){const f=fixture();await f.manager.sync(ticket,{force:true});f.source={id:'1',rawBody:'Original',editVersion:'v1',author:'Example',created:'2026-01-01',visibility:{type:'role',value:'Engineering'},jsdPublic:true};f.manager.comments=async()=>[f.source];return f;}
const payload={body:'Edited',edit:{id:'1',version:'v1'},language:'English'};
(async()=>{
 const f=await ready(),r=await f.manager.prepareChange(ticket,'EXAMPLE-2','comment',payload);
 check(r.args.commentId==='1'&&r.args.contentFormat==='html'&&!r.args.parentId,'edit exact existing ID, not reply/new');check(r.editContext.before==='Original'&&r.after==='Edited','before/after retained');check(r.args.commentVisibility.value==='Engineering','preserve restriction');check(!f.writes.length,'review does not write');
 f.source.editVersion='v2';await assert.rejects(()=>f.manager.applyChange(r),/댓글이 변경/);check(!f.writes.length,'late conflicts never overwrite');
 await assert.rejects(()=>f.manager.prepareChange(ticket,'EXAMPLE-2','comment',payload),/댓글이 변경/);f.source.editVersion='v1';
 await assert.rejects(()=>f.manager.prepareChange(ticket,'EXAMPLE-2','comment',{...payload,body:'Original'}),/변경된 내용이 없습니다/);
 f.source.visibilityUnknown=true;await assert.rejects(()=>f.manager.prepareChange(ticket,'EXAMPLE-2','comment',payload),/공개 범위/);f.source.visibilityUnknown=false;
 const fresh=await f.manager.prepareChange(ticket,'EXAMPLE-2','comment',payload);let refreshed=0;f.manager.refreshAfterWrite=()=>{refreshed++;return Promise.resolve({})};f.connection.writeTool=async(name,args)=>{f.writes.push(args);return[{commentId:'1'}]};await f.manager.applyChange(fresh);check(f.writes.length===1&&refreshed===1,'one edit and automatic refresh');
 const mismatch=await ready(),wrong=await mismatch.manager.prepareChange(ticket,'EXAMPLE-2','comment',payload);await assert.rejects(()=>mismatch.manager.applyChange(wrong),/변경 결과/);check(Boolean((await mismatch.manager.read(ticket)).uncertainWrite),'wrong response ID marks uncertain instead of claiming success');
 const jsm=await ready();jsm.issues.get('EXAMPLE-2').fields.project.projectTypeKey='service_desk';jsm.source.jsdPublic=false;const internal=await jsm.manager.prepareChange(ticket,'EXAMPLE-2','comment',{...payload,visibility:'public'});check(internal.args.jsmCommentType==='internalNote','editing never widens an internal note even if payload asks public');
 const main=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),block=main.slice(main.indexOf('// BEGIN ATLASSIAN CONNECTION'),main.indexOf('// END ATLASSIAN CONNECTION'));const ctx=vm.createContext({URL,URLSearchParams,Buffer,setTimeout,clearTimeout,PLUGIN_ID:'test',crypto:require('crypto'),http:{},https:{},shell:{}});vm.runInContext(block+';globalThis.Connection=AtlassianRovoConnection',ctx);const connection=Object.create(ctx.Connection.prototype);Object.defineProperty(connection,'prefs',{value:{cloudId:'test-cloud'}});connection.hasWriteAccess=()=>true;connection.now=()=>0;connection.epoch=1;
 check(Boolean(connection.authorizeInteractiveWrite('addOrEditJiraIssueComment',r.args)),'actual connection accepts confirmed HTML edit ID');assert.throws(()=>connection.authorizeInteractiveWrite('addOrEditJiraIssueComment',{...r.args,commentId:'../1'}));assert.throws(()=>connection.authorizeInteractiveWrite('addOrEditJiraIssueComment',{...r.args,parentId:'1'}));
 console.log('PASS Jira comment editing: '+count+' checks plus rejection assertions; exact edit, restriction, stale/deleted source guard, explicit confirmation, HTML write gate, response identity, automatic refresh. No live writes.');
})().catch(e=>{console.error(e);process.exit(1)});

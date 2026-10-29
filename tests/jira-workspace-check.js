const assert=require("assert"),fs=require("fs"),path=require("path"),vm=require("vm"),crypto=require("crypto");
const main=fs.readFileSync(path.join(__dirname,"../main.js"),"utf8"),source=fs.readFileSync(path.join(__dirname,"../resources/jira-workspace.js"),"utf8");
class TFile{constructor(path){this.path=path;}}
const context=vm.createContext({crypto,URL,Buffer,setTimeout,clearTimeout,https:{},Modal:class{},MarkdownRenderChild:class{},TFile,PLUGIN_ID:"test",normalizePath:p=>p.replace(/\\/g,"/"),normalizeTicketId:t=>String(t||"").toUpperCase(),parseYaml:()=>({}),safeFileName:n=>n.replace(/[\\/<>:"|?*]/g,"-"),atlassianTarget:(_p,v,site)=>{if(/^EXAMPLE-\d+$/.test(v))return v;const u=new URL(v);if(u.origin!==site)throw Error("target");return u.pathname.split("/").pop()},atlassianError:code=>Object.assign(Error(code),{atlassianCode:code}),localIsoDateTime:()=>"2026-10-29T16:40:00",decodeTodoDetail:v=>Buffer.from(v,"base64").toString(),encodeTodoDetail:v=>Buffer.from(v).toString("base64"),stripCltTodoMetadata:v=>v.replace(/<!--.*?-->/g,""),appendEntryToMarkdownSection:(text,heading,entry)=>text+"\n"+entry});
vm.runInContext(source+";globalThis.api={JiraTicketWorkspace,jiraDate,jiraMarkdown,jiraNormalizeIssue,jiraHasTicket,jiraTimeline,jiraPromptHistory,jiraDownloadUrl,jiraImageBytes};",context);
const api=context.api,ticket="CR0000000",site="https://example.atlassian.net",plain=v=>JSON.parse(JSON.stringify(v));let count=0;
const check=(value,label)=>{count++;assert(value,label)};
function fixture(){
  const root=new TFile("Work/Tickets/"+ticket+"/"+ticket+".md"),files=new Map([[root.path,"manual content\n## ✅ To-Do\n"]]),cache=new Map(),fm={},calls=[],writes=[];
  const raw=(id,key,title,parent,level=0)=>({id:String(id),key,fields:{summary:title,parent:parent?{key:parent}:null,issuetype:{name:level===1?"Epic":level<0?"Sub-task":"Task",hierarchyLevel:level,subtask:level<0},status:{id:"1",name:"In Progress",statusCategory:{key:"indeterminate"}},duedate:"2026-11-12",customFields:{"Plan Start Date":{id:"customfield_10000",value:"2026-11-01"}},assignee:{displayName:"Example User"},attachment:[],project:{projectTypeKey:"software"},updated:"2026-10-29T01:00:00Z"}});
  const issues=new Map([["EXAMPLE-1",raw(1,"EXAMPLE-1",ticket+" Original",null,1)],["EXAMPLE-2",raw(2,"EXAMPLE-2",ticket+" Development","EXAMPLE-1")],["EXAMPLE-3",raw(3,"EXAMPLE-3","Development","EXAMPLE-2",-1)]]);
  issues.get("EXAMPLE-3").fields.attachment=[{id:"111",filename:"image.png",size:12,mimeType:"image/png"}];
  const state={commentFail:false,ambiguous:false,failWrite:false,emptyWrite:false,searchRepeat:false,transitions:[{id:"2",name:"Complete",to:{id:"2",name:"Done"},fields:{},isAvailable:true}]};
  const connection={prefs:{enabled:true,autoTicketSync:true,editingEnabled:true,site,cloudId:"test-cloud",startField:"Plan Start Date"},hasLogin:()=>true,hasWriteAccess:()=>connection.prefs.editingEnabled,readTool:async(name,args)=>{
    calls.push([name,plain(args)]);
    if(name==="getJiraIssue")return [plain(issues.get(args.issueIdOrKey))];
    if(name==="searchJiraIssuesUsingJql"){
      if(args.jql.startsWith("summary"))return [{issues:[plain(issues.get("EXAMPLE-2")),...(state.ambiguous?[raw(4,"EXAMPLE-4",ticket+" Another",null,1)]:[])]}];
      const key=args.jql.match(/parent = (\S+)/)?.[1];return [{issues:[...issues.values()].filter(i=>i.fields.parent?.key===key).map(i=>{const row=plain(i);delete row.fields.attachment;return row})}];
    }
    if(name==="listJiraIssueComments"){
      if(state.commentFail&&args.issueIdOrKey==="EXAMPLE-3")throw Error("private service error");
      const row={id:String(args.startAt+1),author:{displayName:"Example User"},body:args.startAt?"- second\n- list":"first",created:args.startAt?"2026-10-29T00:10:00Z":"2026-10-29T00:00:00Z",updated:"2026-10-29T00:15:00Z",jsdPublic:true};
      return [{comments:[row],startAt:args.startAt,total:2,isLast:args.startAt===1}];
    }
    if(name==="downloadJiraIssueAttachment")return [{downloadUrl:"https://api.media.atlassian.com/file/test-file/binary?token=test-only",downloadCommand:"do not run"}];
    if(name==="listJiraIssueTransitions")return [{transitions:plain(state.transitions)}];throw Error(name);
  },authorizeInteractiveWrite:(name,args)=>({name,args}),writeTool:async(name,args)=>{writes.push([name,plain(args)]);if(state.failWrite)throw Error("uncertain");if(state.emptyWrite)return [];if(name==="editJiraIssue")issues.get(args.issueIdOrKey).fields.duedate=args.fields.duedate;if(name==="transitionJiraIssue")issues.get(args.issueIdOrKey).fields.status={id:"2",name:"Done",statusCategory:{key:"done"}};return [{commentId:"900",success:true}]}};
  const vault={configDir:".obsidian",adapter:{exists:async p=>cache.has(p),mkdir:async p=>cache.set(p,"folder"),write:async(p,text)=>cache.set(p,text),read:async p=>cache.get(p)},getAbstractFileByPath:p=>files.has(p)?new TFile(p):null,read:async f=>files.get(f.path),process:async(f,fn)=>files.set(f.path,fn(files.get(f.path))),create:async(p,text)=>{if(files.has(p))throw Error("exists");files.set(p,text);return new TFile(p)},createBinary:async(p,bytes)=>{files.set(p,bytes);return new TFile(p)}};
  const plugin={atlassianConnection:connection,manifest:{dir:".obsidian/plugins/test"},app:{vault,fileManager:{processFrontMatter:async(_f,fn)=>fn(fm)}},rootTicketFile:()=>root,ticketFolder:()=>"Work/Tickets/"+ticket,ticketAssetsFolder:()=>"Work/Tickets/"+ticket+"/assets",ensureFolder:async()=>{},refreshViews:()=>{},getTodoWorkflow:()=>[{key:"in-progress",label:"Doing",enabled:true},{key:"done",label:"Done",enabled:true}],assertTodoStatusEnabled:s=>{if(!["in-progress","done"].includes(s))throw Error("disabled")},touchTodoLastChecked:async()=>{},translateTextForExport:async text=>"translated: "+text};
  const manager=new api.JiraTicketWorkspace(plugin);manager.rootProperties=async()=>({file:root,text:files.get(root.path),fm});manager.fetchImage=async()=>Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);manager.now=()=>Date.parse("2026-10-29T07:40:00Z");
  manager.refreshAfterWrite=()=>{}; // Foreground acknowledgement is tested independently from background refresh.
  return {manager,plugin,connection,files,cache,fm,issues,calls,writes,state,root};
}
(async()=>{
  check(api.jiraDate("2026-02-29")===""&&api.jiraDate("2028-02-29T10:00:00Z")==="2028-02-29","validated calendar dates, no timezone shift");
  check(api.jiraHasTicket("("+ticket+") details",ticket)&&!api.jiraHasTicket(ticket+"1",ticket),"exact ticket token boundaries");
  check(!api.jiraMarkdown("![bad](https://evil.test/a.png) ![[Private/Secret]] [run](javascript:alert)").includes("![["),"remote data cannot embed arbitrary local files");
  check(!api.jiraMarkdown("[secret](https://example.test/?token=test-only)").includes("test-only"),"signed query removed");
  check(!api.jiraMarkdown("<script>bad()</script><p>Safe</p>").includes("bad()"),"inert HTML fallback");
  for(const url of ["http://api.media.atlassian.com/file/a/binary","https://evil.test/file/a/binary","https://api.media.atlassian.com/else","https://api.media.atlassian.com:444/file/a/binary"])assert.throws(()=>api.jiraDownloadUrl(url));
  check(api.jiraDownloadUrl("https://api.media.atlassian.com/file/a/binary?token=fixture").hostname==="api.media.atlassian.com","media origin allowlist");
  check(!api.jiraImageBytes(Buffer.from("<svg>malicious</svg>")),"SVG/HTML not accepted as image");
  const f=fixture();let bundle=await f.manager.sync(ticket,{force:true});
  check(f.fm.jira===site+"/browse/EXAMPLE-1","links actual top relevant Epic, not development task");
  check(bundle.issues.length===3&&bundle.comments.length===6,"complete hierarchy and paginated comments");
  check(bundle.assets.length===1&&f.calls.some(c=>c[0]==="getJiraIssue"&&c[1].issueIdOrKey==="EXAMPLE-3"),"child attachment details fetched even if search omits attachments");
  check(f.writes.length===0,"automatic synchronization never writes Jira");
  check(f.files.get(f.root.path).startsWith("manual content"),"manual root text preserved");
  check(bundle.notePath&&f.files.get(bundle.notePath).includes("snm-jira-comments:start"),"navigable local Jira comments archive");
  const note=bundle.notePath;f.files.set(note,"manual before\n"+f.files.get(note)+"\nmanual after");await f.manager.sync(ticket,{force:true});
  check(f.files.get(note).startsWith("manual before")&&f.files.get(note).endsWith("manual after"),"archive replaces only managed region");
  const before=f.calls.length;await f.manager.sync(ticket);check(f.calls.length===before,"15 minute cache prevents repeated scans");
  await f.manager.translate(ticket,bundle.comments.slice(0,1),"ko");bundle=await f.manager.sync(ticket,{force:true});check(Boolean(bundle.comments[0].translations.ko),"matching body hash preserves translation across refresh");
  f.state.commentFail=true;bundle=await f.manager.sync(ticket,{force:true});check(bundle.stale&&bundle.comments.filter(c=>c.issueKey==="EXAMPLE-3").length===2,"partial comment failure retains labeled saved history");f.state.commentFail=false;
  bundle=await f.manager.schedule(ticket);check(bundle.scheduleReadAt&&bundle.issues[2].start==="2026-11-01","fresh configured Jira start field");
  const result=await f.manager.createTodos(ticket,[bundle.issues[2]],"in-progress","start");check(result.created===1&&f.files.get(f.root.path).includes("clt-todo-due:2026-11-01T16:40"),"Start dates become local due with creation-time fallback");
  const again=await f.manager.createTodos(ticket,[bundle.issues[2]],"in-progress","due");check(again.skipped===1&&again.created===0,"immutable issue source identity deduplicates, not title");
  await assert.rejects(()=>f.manager.createTodos(ticket,[bundle.issues[1]],"waiting","due"),/disabled/);
  bundle.comments.push({id:"restricted",issueKey:"EXAMPLE-2",created:"2026-10-29T00:05:00Z",body:"INTERNAL-ONLY",jsdPublic:false});
  const history=api.jiraPromptHistory(bundle,[{type:"Work Note",time:"2026-10-29 09:03:00",author:"SN author",content:"SN-EVENT"}]);
  check(!history.includes("INTERNAL-ONLY")&&history.includes("1개는 외부 AI")&&history.includes("상위 EXAMPLE-1"),"external prompt labels hierarchy and excludes restricted comments");
  check(history.indexOf("first")<history.indexOf("SN-EVENT")&&history.indexOf("SN-EVENT")<history.indexOf("- second"),"merged UTC and naive KST chronological context");
  const manual=fixture();manual.fm.jira=site+"/browse/EXAMPLE-2";await manual.manager.sync(ticket,{force:true});check(manual.fm.jira.endsWith("EXAMPLE-2"),"existing manual link never overwritten");
  const ambiguous=fixture();ambiguous.state.ambiguous=true;const candidates=await ambiguous.manager.sync(ticket,{force:true});check(!ambiguous.fm.jira&&candidates.candidates.length===2,"ambiguous roots require human choice");
  const readonly=fixture();readonly.connection.prefs.enabled=false;readonly.manager.queueSync(ticket);await readonly.manager.tail;check(readonly.calls.length===0,"integration off means no background calls");
  const edit=fixture();await edit.manager.sync(ticket,{force:true});edit.connection.prefs.editingEnabled=false;await assert.rejects(()=>edit.manager.prepareChange(ticket,"EXAMPLE-2","due",{due:""}),/write/);edit.connection.prefs.editingEnabled=true;
  const due=await edit.manager.prepareChange(ticket,"EXAMPLE-2","due",{due:"2026-12-01"});check(edit.writes.length===0,"preparing review does not mutate");await edit.manager.applyChange(due);check(edit.writes.length===1&&edit.issues.get("EXAMPLE-2").fields.duedate==="2026-12-01","confirmed due write read back");await assert.rejects(()=>edit.manager.applyChange(due),/만료|변경/);
  const tampered=await edit.manager.prepareChange(ticket,"EXAMPLE-2","due",{due:""});tampered.args.fields.duedate="2027-01-01";await assert.rejects(()=>edit.manager.applyChange(tampered),/만료|변경/);
  const conflict=await edit.manager.prepareChange(ticket,"EXAMPLE-2","due",{due:""});edit.issues.get("EXAMPLE-2").fields.duedate="2026-12-02";await assert.rejects(()=>edit.manager.applyChange(conflict),/원본 값/);check(edit.writes.length===1,"conflict before dispatch never sends");
  const status=await edit.manager.prepareChange(ticket,"EXAMPLE-2","status",{transitionId:"2"});await edit.manager.applyChange(status);check(edit.issues.get("EXAMPLE-2").fields.status.id==="2","actual available transition and target status verified");
  edit.state.transitions[0].fields={resolution:{required:true,hasDefaultValue:false}};await assert.rejects(()=>edit.manager.prepareChange(ticket,"EXAMPLE-2","status",{transitionId:"2"}),/추가 필수/);
  const comment=await edit.manager.prepareChange(ticket,"EXAMPLE-2","comment",{body:"Human-confirmed comment",language:"English"});edit.state.failWrite=true;await assert.rejects(()=>edit.manager.applyChange(comment),/중복 전송/);const writes=edit.writes.length;bundle=await edit.manager.sync(ticket,{force:true});check(Boolean(bundle.uncertainWrite),"uncertain outcome lock survives automatic refresh");const retry=await edit.manager.prepareChange(ticket,"EXAMPLE-2","comment",{body:"same",language:"English"});await assert.rejects(()=>edit.manager.applyChange(retry),/미확인/);check(edit.writes.length===writes,"no automatic mutation retry or duplicate resend");
  await edit.manager.unlockWrite(ticket);edit.state.failWrite=false;edit.state.emptyWrite=true;const empty=await edit.manager.prepareChange(ticket,"EXAMPLE-2","comment",{body:"test"});await assert.rejects(()=>edit.manager.applyChange(empty),/중복 전송/);check(Boolean((await edit.manager.read(ticket)).uncertainWrite),"empty write result never reported as success");
  check(main.includes("new JiraTicketWorkspace(this)")&&(main.match(/this\.jiraWorkspace\?\.queueSync\(normalized\)/g)||[]).length===2,"both status-only and full SN refresh paths queue Jira reads");
  check(main.includes("new ScheduleSourceModal(this.app, this, ticketId)")&&main.includes("jiraPromptHistory(jira, ticket.entries"),"schedule source choice and AI prompt integration wired");
  console.log(`PASS Jira workspace: ${count} checks plus rejection contracts; roots, full comments, safe media, caches, archives, translations, merged prompts, local schedules and one-use human-confirmed mutations. No live Jira writes.`);
})().catch(error=>{console.error(error);process.exit(1)});

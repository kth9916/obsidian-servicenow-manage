const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const root=path.join(__dirname,'..'),main=fs.readFileSync(path.join(root,'main.js'),'utf8'),dashboard=fs.readFileSync(path.join(root,'resources/업무현황.md'),'utf8');
const helpers=['normalizedHeadingText','stripWorkLogEntryPrefix','extractTicketWorkLogs'].map(name=>main.match(new RegExp('function '+name+'\\([^]*?\\n\\}'))[0]).join('\n');
const parse=new Function('markdown',helpers+'\nreturn extractTicketWorkLogs(markdown);');
const method=name=>{const start=main.search(new RegExp('^  (?:async )?'+name+'\\(','m')),rest=main.slice(start),end=rest.slice(1).search(/\n  (?:async )?\w+\(/);assert(start>=0);return rest.slice(0,end+1).trim();};
let checks=0;const check=(v,m)=>{checks++;assert(v,m)};
const fixture=['---','id: CR0000000','---','## 📝 작업 일지','', '```clt-ticket-worklog-actions','ticket: CR0000000','```','','- 2026-10-28 17:42 : Modern record','    - Result: preserved','', '### 2026-10-26 | Legacy record','','- State: QA target 2026-11-27','- Evidence: old event 2026-09-01','- 2026-12-01 planned deployment, not a record','- 2026-10-28 17:14 : Linked record','    - Detail: [[Example]]','','### Manual appendix','- Keep this manual paragraph 2027-01-01','','## To-Do','- [ ] 2028-01-01 task','','## Meetings','Keep meeting data'].join('\n');
const record=text=>'## 작업 일지\n\n'+text+'\n\n## To-Do\nKeep tasks';
const entries=parse(fixture);
check(entries.length===3,'standard records and a dated legacy subsection form three records, not prose bullets');
check(entries.map(e=>e.dateTime).join('|')==='2026-10-28 17:42|2026-10-26|2026-10-28 17:14','dates come from record starts only');
check(entries[1].kind==='heading'&&entries[1].contentMarkdown.startsWith('Legacy record'),'legacy heading has one title and a verified date');
check(entries[1].contentMarkdown.includes('- State: QA target 2026-11-27')&&entries[1].contentMarkdown.includes('2026-12-01 planned'),'all legacy body bullets remain together');
check(!entries[0].raw.includes('Legacy record')&&!entries[2].sourceMarkdown.includes('Manual appendix'),'record deletion boundaries do not absorb another heading');
check(!entries.some(e=>e.raw.includes('Keep tasks')||e.raw.includes('Keep meeting')),'other sections remain outside the parser');
check(parse(record('- 2026-01-02 : date only'))[0].dateTime==='2026-01-02','date-only records remain supported');
check(parse(record('- 2026-01-02 9:05 : one-digit hour'))[0].dateTime==='2026-01-02 09:05','hours normalize for chronological comparison');
check(parse(record('- 2026-01-02T09:05:30 : timestamp'))[0].dateTime==='2026-01-02 09:05:30','ISO timestamps preserve verified seconds');
check(parse(record('- **2026-01-02 09:05** : bold timestamp'))[0].dateTime==='2026-01-02 09:05','legacy formatted timestamps remain supported');
check(parse(record('- 2026-02-31 : invalid day'))[0].dateTime==='','invalid calendar dates never become creation dates');
check(parse(record('- 2026-01-02 25:05 : invalid hour'))[0].dateTime==='','invalid times never become creation dates');
check(parse(record('- Reference date 2027-01-01\n- More context')).length===1&&parse(record('- Reference date 2027-01-01'))[0].dateTime==='','undated notes remain one undated record, not a fabricated timestamp');
const fenced=record('- 2026-01-02 09:05 : Real\n    - Nested item\n    ```md\n## Not a section boundary\n- 2030-01-01 : example\n    ```\n\n<!--\n### 2031-01-01 : hidden example\n-->');
check(parse(fenced).length===1&&parse(fenced)[0].raw.includes('2030-01-01'),'code and comments cannot create records or section boundaries');
check(parse('```md\n## 작업 일지\n- 2030-01-01 : example\n```\n'+record('- 2026-01-02 : Real')).length===1,'a code example cannot select the worklog section');
check(parse(fixture.replace(/\n/g,'\r\n')).map(e=>e.sourceMarkdown).join('|')===entries.map(e=>e.sourceMarkdown).join('|'),'CRLF retains identical normalized source identities');
check(!parse(record('- 2026-01-02 : Real\n```md\n## To-Do\n- important task'))[0].sourceMarkdown.includes('important task'),'unfinished fences cannot swallow the rest of a note');
check(!parse(record('- 2026-01-02 : Real\n<!--\n## To-Do\n- important task'))[0].sourceMarkdown.includes('important task'),'unfinished comments cannot swallow the rest of a note');
check(parse(record('- 2026-01-02 : Real\n````md\n```clt-ticket-worklog-actions\n```\n````'))[0].actionLine===-1,'an action block example is not the actual history owner');
const exportParser=new Function('app','stripMarkdown',dashboard.slice(dashboard.indexOf('function extractWorkLogs('),dashboard.indexOf('function getLatestWorkLog('))+';return extractWorkLogs;')({plugins:{getPlugin:()=>({extractTicketWorkLogs:parse})}},v=>v);
check(exportParser(fixture).map(e=>e.dateTime).join('|')===entries.map(e=>e.dateTime).join('|'),'dashboard and source notes use exactly the same records');
check(exportParser(fixture)[1].sourceMarkdown===entries[1].sourceMarkdown,'dashboard preserves exact deletion identity');
class TFile{constructor(p){this.path=p}}
const notices=[],api=new Function('extractTicketWorkLogs','TFile','normalizePath','Notice','return {'+['deleteTicketWorkLog','decorateTicketWorkLogSource'].map(method).join(',')+'};')(parse,TFile,v=>v,class{constructor(v){notices.push(v)}});
const memory={text:fixture,writes:0},file=new TFile('Work/CR0000000.md');
const plugin={...api,app:{vault:{getAbstractFileByPath:()=>file,process:async(f,fn)=>{const result=fn(memory.text);if(result!==memory.text)memory.writes++;memory.text=result;}}}};
class Element{
 constructor(tag='div',cls='',parent=null){this.tag=tag;this.cls=cls;this.children=[];this.parent=parent;this.dataset={};if(parent)parent.children.push(this);}
 createEl(tag,o={}){return new Element(tag,o.cls||'',this)}createDiv(o={}){return this.createEl('div',o)}
 addClass(c){this.cls+=' '+c}remove(){this.removed=true;if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this)}
 matches(s){return s==='ul'?this.tag==='ul':s.split(',').some(c=>this.cls.includes(c.trim().slice(1)))}
 closest(s){for(let node=this;node;node=node.parent)if(node.matches(s))return node;return null}
 querySelectorAll(s){return this.children.flatMap(c=>[...(c.matches(s)?[c]:[]),...c.querySelectorAll(s)])}
 querySelector(s){return this.querySelectorAll(s)[0]||null}
}
const doc=new Element('div','markdown-rendered'),native=new Element('ul','',doc),legacy=new Element('h3','',doc),body=new Element('ul','',doc),manual=new Element('h3','',doc),todo=new Element('ul','',doc),panel=new Element('div','clt-ticket-worklog-panel',doc),inner=new Element('ul','',panel);
panel.dataset.cltWorklogReady='true';
const spans=new Map([[native,{lineStart:entries[0].startLine,lineEnd:entries[0].endLine-1}],[legacy,{lineStart:entries[1].startLine,lineEnd:entries[1].startLine}],[body,{lineStart:entries[1].startLine+2,lineEnd:entries[2].endLine-1}],[manual,{lineStart:20,lineEnd:21}],[todo,{lineStart:24,lineEnd:24}],[inner,{lineStart:entries[0].startLine,lineEnd:entries[0].endLine-1}]]),ctx={getSectionInfo:el=>spans.get(el)||null};
let mounts=0;plugin.renderTicketWorkLogCards=()=>{mounts++};
for(let repeat=0;repeat<2;repeat++)for(const el of [native,legacy,body,manual,todo,inner])plugin.decorateTicketWorkLogSource(el,ctx,fixture,entries,'CR0000000',file.path);
check(native.cls.includes('source-hidden')&&legacy.cls.includes('source-hidden')&&body.cls.includes('source-hidden'),'native record fragments hide only behind the canonical action-block owner');
check(!manual.cls.includes('source-hidden')&&!todo.cls.includes('source-hidden')&&!inner.cls.includes('source-hidden'),'manual subsections, other tasks and rendered card Markdown are not hidden');
check(mounts===0,'multiple lists and repeated postprocessing never mount a second complete history');
panel.dataset.cltWorklogReady='false';const unread=new Element('ul','',doc);spans.set(unread,spans.get(native));plugin.decorateTicketWorkLogSource(unread,ctx,fixture,entries,'CR0000000',file.path);check(!unread.cls.includes('source-hidden'),'a pending or failed history read cannot hide native records');panel.dataset.cltWorklogReady='true';
const unknown=new Element('ul','',doc);plugin.decorateTicketWorkLogSource(unknown,{getSectionInfo:()=>null},fixture,entries,'CR0000000',file.path);check(!unknown.cls.includes('source-hidden'),'null source information preserves native content');
const oldText=record('- 2026-01-02 09:05 : old\n\n### 2026-01-01 | legacy\n- detail'),oldRows=parse(oldText),oldDoc=new Element('div','markdown-rendered'),owner=new Element('ul','',oldDoc);const oldCtx={getSectionInfo:el=>el===owner?{lineStart:oldRows[0].startLine,lineEnd:oldRows[0].endLine-1}:null};
plugin.renderTicketWorkLogCards=(list)=>{mounts++;new Element('div','clt-ticket-worklog-cards',oldDoc)};plugin.decorateTicketWorkLogSource(owner,oldCtx,oldText,oldRows,'CR0000000',file.path);check(mounts===1,'legacy notes without an action block mount only at the first record source');
(async()=>{
 await plugin.deleteTicketWorkLog(file.path,entries[0]);
 check(!memory.text.includes('Modern record')&&memory.text.includes('Legacy record')&&memory.text.includes('Manual appendix'),'deleting standard entry preserves dated and manual subsections');
 check(memory.text.includes('## To-Do')&&memory.text.includes('Keep meeting data'),'deleting a record never removes tasks or meetings');
 memory.text=fixture;await plugin.deleteTicketWorkLog(file.path,entries[1]);check(!memory.text.includes('Legacy record')&&memory.text.includes('Linked record')&&memory.text.includes('Modern record'),'legacy delete removes only its own heading and complete body');
 memory.text=fixture.replace('QA target 2026-11-27','QA target changed');let rejected=false;try{await plugin.deleteTicketWorkLog(file.path,entries[1])}catch(_){rejected=true}check(rejected&&memory.text.includes('QA target changed'),'concurrent source changes refuse stale deletion');
 memory.text=fixture;rejected=false;try{await plugin.deleteTicketWorkLog(file.path,{dateTime:'2026-11-27',contentMarkdown:'State'})}catch(_){rejected=true}check(rejected&&memory.text===fixture,'old date-only inferred cards cannot delete prose');
 const duplicate=record('- 2026-01-01 : same\n\n- 2026-01-01 : same');memory.text=duplicate;rejected=false;try{await plugin.deleteTicketWorkLog(file.path,parse(duplicate)[0])}catch(_){rejected=true}check(rejected&&memory.text===duplicate,'identical ambiguous source records cannot delete the wrong copy');
 memory.text=fixture.replace(/\n/g,'\r\n');await plugin.deleteTicketWorkLog(file.path,parse(memory.text)[0]);check(memory.text.includes('\r\n')&&!/(?<!\r)\n/.test(memory.text),'deletion preserves CRLF');
 const eventRefs=[],views=new Set(),renders=[];let resolveOld,fail=false,text=fixture;
 const componentPlugin={app:{vault:{on:(name,cb)=>{eventRefs.push(cb);return cb},cachedRead:async()=>{if(fail)throw Error('read failure');return text}}},renderTicketSectionAction:()=>({button:new Element()}),registerView:(id,v)=>views.add(v),unregisterView:(id,v)=>views.delete(v),renderTicketWorkLogCards:(el,id,rows)=>renders.push(rows)};
 const context=vm.createContext({MarkdownRenderChild:class{constructor(el){this.containerEl=el}registerEvent(){}},extractTicketWorkLogs:parse});vm.runInContext(main.slice(main.indexOf('class TicketWorkLogRenderChild'),main.indexOf('class TicketStatusRenderChild'))+';this.View=TicketWorkLogRenderChild;',context);
 const view=new context.View(new Element(),componentPlugin,file,'CR0000000');view.onload();await new Promise(r=>setImmediate(r));check(renders.length===1&&renders[0].length===3&&views.size===1,'one lifecycle-managed view renders the complete history');
 await view.render();check(renders.length===1,'unchanged refreshes do not create duplicate histories');
 text=fixture.replace('Modern record','Changed record');eventRefs[0](file);await new Promise(r=>setImmediate(r));check(renders.length===2&&renders.at(-1)[0].raw.includes('Changed record'),'manual file changes refresh the same owner');
 componentPlugin.app.vault.cachedRead=()=>new Promise(r=>resolveOld=r);const pending=view.render();componentPlugin.app.vault.cachedRead=async()=>fixture.replace('Modern record','Newest record');await view.render();resolveOld(fixture);await pending;check(renders.at(-1)[0].raw.includes('Newest record'),'late reads cannot restore stale history');
 view.onunload();await view.render();check(!views.size&&view.headingActions.button.removed,'unload removes moved heading controls and the registered view');
 const failureView=new context.View(new Element(),{...componentPlugin,app:{vault:{on:()=>null,cachedRead:async()=>{if(fail)throw Error('read failure');return fixture}}}},file,'CR0000000');fail=true;failureView.onload();await new Promise(r=>setImmediate(r));const error=failureView.errorEl;fail=false;await failureView.render();check(error?.removed&&!failureView.errorEl,'read failures recover without leaving stale error blocks');failureView.onunload();
 const beforeDuplicate=renders.length,duplicateView=new context.View(new Element(),componentPlugin,file,'CR0000000',{getSectionInfo:()=>({lineStart:17,lineEnd:18})});duplicateView.onload();await new Promise(r=>setImmediate(r));check(renders.length===beforeDuplicate&&!duplicateView.sourceList,'a later copied action block cannot create another history owner');duplicateView.onunload();
 console.log('PASS work-log scope: '+checks+' checks; mixed legacy records, exact timestamps, fenced examples, shared dashboard, single owner, null ranges, async lifecycle and safe deletion. Memory-only writes.');
})().catch(e=>{console.error(e);process.exit(1)});

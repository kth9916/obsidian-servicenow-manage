const fs=require('fs'),path=require('path'),assert=require('assert');
const main=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
const method=name=>{const start=main.search(new RegExp('^  (?:async )?'+name+'\\(','m'));if(start<0)return '';const rest=main.slice(start),end=rest.slice(1).search(/\n  (?:async )?\w+\(/);return rest.slice(0,end+1).trim();};
class Element{
 constructor(tag='div',options={},parent=null){this.tag=tag;this.text=options.text||'';this.cls=options.cls||'';this.children=[];this.parent=parent;this.events={};this.hidden=false;this.disabled=false;this.open=false;if(parent)parent.children.push(this);}
 createEl(tag,o={}){return new Element(tag,o,this)}createDiv(o={}){return this.createEl('div',o)}createSpan(o={}){return this.createEl('span',o)}
 addClass(value){this.cls+=' '+value}setText(value){this.text=value}setAttribute(){}addEventListener(name,fn){this.events[name]=fn}
 empty(){for(const child of this.children)child.parent=null;this.children=[];this.text='';}
 get isConnected(){return this.root||Boolean(this.parent?.isConnected)}get textContent(){return this.text+this.children.map(c=>c.textContent).join('')}
 all(){return [this,...this.children.flatMap(c=>c.all())]}
}
const notices=[],errors=[],copied=[];
const api=new Function('normalizeTicketId','localIsoDateTime','Notice','navigator','console','return {'+['getTicketAiPromptState','startTicketAiPrompt','renderTicketStatusControl','registerView','unregisterView','refreshViews'].map(method).filter(Boolean).join(',')+'};')(v=>String(v).toUpperCase(),()=> '2026-11-04T14:00:00',class{constructor(text){notices.push(text)}},{clipboard:{writeText:async text=>copied.push(text)}},{error:(...a)=>errors.push(a),warn(){}});
const Child=new Function('MarkdownRenderChild',main.slice(main.indexOf('class TicketStatusRenderChild'),main.indexOf('class MeetingSectionRenderChild'))+';return TicketStatusRenderChild;')(class{constructor(el){this.containerEl=el}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 let release,finish,calls=0,mode='success',rootPath='Work/Tickets/SR0000000/SR0000000.md';
 const plugin={...api,views:new Map(),data:{tickets:{SR0000000:{shortDescription:'Example request'}}},settings:{},atlassianConnection:{prefs:{enabled:true}},rootTicketFile:()=>({path:rootPath}),rootFolder:()=> 'Work',organizationFeatureEnabled:()=>true,getTicketActivity:()=>({label:'Active',reason:''}),observeResponsiveActions(){},scheduleViewRefresh(){},documentAutomationEnabled:()=>true,app:{metadataCache:{getFileCache:()=>({frontmatter:{status:'Open'}})}},generateAiPromptForTicket:async(_ticket,{onProgress=()=>{}}={})=>{calls++;onProgress('Jira 댓글 확인 중…');await new Promise(r=>release=r);plugin.refreshViews('SR0000000');await new Promise(r=>finish=r);if(mode==='error')throw Error('Example failure');if(mode==='empty')return null;return {prompt:'SR_TEMPLATE.md\nSR No: SR0000000\nChronological notes',messages:mode==='warnings'?['Example document warning']:[]};}};
 const mount=()=>{const el=new Element();el.root=true;const view=new Child(el,plugin,'SR0000000');view.onload();return {el,view}};
 return {plugin,mount,release:()=>release(),finish:()=>finish(),calls:()=>calls,setMode:value=>mode=value,setPath:value=>rootPath=value};
}
const button=el=>el.all().find(e=>e.tag==='button'&&/프롬프트 생성|Jira 댓글 확인/.test(e.text));
const preview=el=>el.all().find(e=>e.cls.includes('clt-ai-prompt-details'));
let checks=0;const check=(value,label)=>{checks++;assert(value,label)};
(async()=>{
 const f=fixture(),first=f.mount();const originalButton=button(first.el),pending=originalButton.events.click();await tick();f.release();await tick();
 check(!originalButton.isConnected,'Jira archive refresh really detaches the original action DOM');
 check(button(first.el).disabled,'the replacement button keeps the in-progress state');
 f.finish();await pending;await tick();
 check(!preview(first.el).hidden&&preview(first.el).textContent.includes('SR No: SR0000000'),'result must appear in the live replacement view, not a detached element');
 check(!button(first.el).disabled&&f.calls()===1,'completion unlocks the current button');
 await first.el.all().find(e=>e.text==='프롬프트 복사').events.click({preventDefault(){}});check(copied.at(-1).includes('SR No: SR0000000'),'copy uses the saved live result');
 const second=f.mount();check(!preview(second.el).hidden&&preview(second.el).textContent.includes('Chronological notes'),'a remounted/split note reuses the completed result');
 preview(first.el).open=false;preview(first.el).events.toggle();f.plugin.refreshViews('SR0000000');check(!preview(first.el).open,'collapsed preview remains collapsed after a status refresh');
 const retry=button(first.el).events.click();await tick();const state=f.plugin.getTicketAiPromptState('SR0000000');const coalesced=f.plugin.startTicketAiPrompt('SR0000000');
 check(f.calls()===2&&button(second.el).disabled,'both views share one generation and prevent duplicate requests');
 check(!preview(first.el).hidden&&preview(first.el).textContent.includes('Chronological notes'),'previous result remains readable during regeneration');
 f.plugin.refreshViews('SR0000000');f.release();await tick();f.finish();await Promise.all([retry,coalesced]);await tick();check(!state.running&&state.prompt.includes('SR_TEMPLATE.md'),'coalesced generation settles normally');
 f.setMode('error');const failed=button(first.el).events.click();await tick();f.release();await tick();f.finish();await failed;await tick();
 check(!button(first.el).disabled&&first.el.textContent.includes('Example failure'),'failure remains visible after re-render and allows retry');
 check(!preview(first.el).hidden&&state.prompt.includes('SR No:'),'failure cannot discard the previous successful prompt');
 f.setMode('success');const recovered=button(first.el).events.click();await tick();f.release();await tick();f.finish();await recovered;await tick();check(!state.error&&state.prompt&&preview(first.el).open,'retry clears failure and opens a fresh result');
 const empty=fixture();empty.setMode('empty');const e=empty.mount(),emptyJob=button(e.el).events.click();await tick();empty.release();await tick();empty.finish();await emptyJob;await tick();check(!button(e.el).disabled&&e.el.textContent.includes('생성 결과'),'empty/notice-only generator results cannot silently look successful');
 const closed=fixture(),old=closed.mount(),closedJob=button(old.el).events.click();await tick();old.view.onunload();old.el.root=false;closed.release();await tick();closed.finish();await closedJob;await tick();const reopened=closed.mount();check(!preview(reopened.el).hidden,'closing the view during generation does not lose the completed result');
 const rootState=closed.plugin.getTicketAiPromptState('SR0000000');closed.setPath('Other/Tickets/SR0000000/SR0000000.md');check(closed.plugin.getTicketAiPromptState('SR0000000')!==rootState,'same ticket number in another root does not expose an old prompt');
 const memory=fixture();for(let n=0;n<20;n++)memory.plugin.getTicketAiPromptState('SR'+String(n).padStart(7,'0'));check(memory.plugin.ticketAiPromptStates.size<=8,'completed previews have a bounded in-memory cache, never new disk storage');
 const pinned=fixture(),mounted=pinned.mount(),liveState=pinned.plugin.getTicketAiPromptState('SR0000000');liveState.prompt='Visible result';for(let n=1;n<20;n++)pinned.plugin.getTicketAiPromptState('SR'+String(n).padStart(7,'0'));check(pinned.plugin.getTicketAiPromptState('SR0000000')===liveState&&liveState.prompt==='Visible result','open ticket views cannot lose their preview under cache pressure');mounted.view.onunload();
 const unloaded=fixture(),u=unloaded.mount(),unloadedJob=button(u.el).events.click();await tick();u.view.onunload();unloaded.plugin.ticketAiPromptStates.clear();const noticeCount=notices.length;unloaded.release();await tick();unloaded.finish();await unloadedJob;check(unloaded.plugin.ticketAiPromptStates.size===0&&notices.length===noticeCount,'plugin unload cannot resurrect previews or late completion notices');
 check(main.includes('onProgress("Jira 댓글 확인 중…")')&&main.includes('onProgress("프롬프트 구성 중…")'),'real generation reports remote and assembly stages');
 console.log('PASS AI prompt lifecycle: '+checks+' checks; refresh/remount, exact live result/copy, split-view coalescing, previous preview, errors/retry/empty result, closed view, root isolation and bounded memory. No live requests or disk writes.');
})().catch(error=>{console.error(error);process.exit(1)});

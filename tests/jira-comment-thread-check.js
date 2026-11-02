const fs=require('fs'),path=require('path'),assert=require('assert'),vm=require('vm');
const template=fs.readFileSync(path.join(__dirname,'jira-workspace-check.js'),'utf8');
const {fixture,api,ticket,context}=new Function('require','__dirname',template.slice(0,template.indexOf('(async()=>{'))+';return {fixture,api,ticket,context};')(require,__dirname);
vm.runInContext('api.jiraCommentThreads=jiraCommentThreads;',context);
let checks=0;const check=(v,m)=>{checks++;assert(v,m)},plain=v=>JSON.parse(JSON.stringify(v));
const comment=(id,parentId='',minute=0,issueKey='EXAMPLE-2')=>({id:String(id),parentId:String(parentId),issueId:issueKey==='EXAMPLE-2'?'2':'3',issueKey,author:id==='1'?'Original author':'Reply author '+id,created:new Date(Date.UTC(2026,9,30,6,minute)).toISOString(),body:'Comment '+id,hash:'hash-'+id,jsdPublic:true,translations:{},url:'https://example.atlassian.net/browse/'+issueKey+'?focusedCommentId='+id});
const ids=groups=>groups.flatMap(g=>g.rows.map(r=>r.event.id));
class Element {
 constructor(tag='div',o={},doc={activeElement:null}){this.tagName=tag;this.children=[];this.parentElement=null;this.cls=o.cls||'';this.text=o.text||'';this.attrs={...o.attr};this.dataset={};this.listeners={};this.style={setProperty:(k,v)=>this.styles[k]=v};this.styles={};this.ownerDocument=doc;this.scrollTop=0;}
 get isConnected(){return Boolean(this.parentElement)||this.root===true;}
 get textContent(){return this.text+this.children.map(c=>c.textContent).join('');}
 createEl(tag,o={}){const e=new Element(tag,o,this.ownerDocument);this.appendChild(e);return e;}
 createDiv(o={}){return this.createEl('div',o);}createSpan(o={}){return this.createEl('span',o);}
 appendChild(e){e.remove();this.children.push(e);e.parentElement=this;return e;}
 remove(){if(this.parentElement){const a=this.parentElement.children;a.splice(a.indexOf(this),1);this.parentElement=null;}}
 empty(){for(const e of this.children)e.parentElement=null;this.children=[];this.text='';}
 setText(t){this.text=t;}setAttribute(k,v){this.attrs[k]=v;}addClass(c){this.cls+=' '+c;}
 addEventListener(k,fn){this.listeners[k]=fn;}contains(e){return this===e||this.children.some(c=>c.contains(e));}
 focus(){this.ownerDocument.activeElement=this;}setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}
 querySelectorAll(){return [];}
}
const elements=(root,predicate)=>[...(predicate(root)?[root]:[]),...root.children.flatMap(e=>elements(e,predicate))];
const hasClass=(e,c)=>e.cls.split(' ').includes(c);
function viewFor(rows){const f=fixture(),view=Object.create(api.JiraWorkspaceModal.prototype);f.plugin.jiraWorkspace=f.manager;view.initialize(f.plugin,ticket,'comments');view.app=f.plugin.app;view.bundle={comments:rows,issues:[{id:'2',key:'EXAMPLE-2',title:'Example issue',pic:'Example owner'}],assets:[],root:{id:'2',key:'EXAMPLE-2'}};view.contentEl=new Element();view.contentEl.root=true;view.body=view.contentEl.createDiv();view.eventsEl=view.body.createDiv();view.pager=view.body.createDiv();view.status=view.body.createDiv();view.clearRenderers=()=>{};view.markdown=(host,text)=>host.createEl('p',{cls:'snm-jira-markdown',text});view.requestVisibleTranslations=()=>Promise.resolve();return {view,f};}
(async()=>{
 const rows=[comment('2','1',5),comment('1','',0),comment('3','1',10)];const snapshot=JSON.stringify(rows);let groups=api.jiraCommentThreads(rows);
 check(groups.length===1&&ids(groups).join(',')==='1,2,3','reply-first input becomes original then chronological replies');
 check(groups[0].rows[1].parent.author==='Original author'&&groups[0].rows[1].depth===1,'reply keeps its actual source author and relation');
 check(ids(api.jiraCommentThreads(rows,rows,'asc')).join(',')==='1,2,3','oldest order never reverses a conversation');
 check(JSON.stringify(rows)===snapshot,'grouping never mutates cached comments or translations');
 const mention=comment('mention','',15);mention.body='@Original author thank you';check(api.jiraCommentThreads([rows[1],mention]).length===2,'mentions and nearby dates never invent a reply relationship');
 const native=fixture(),readNative=native.connection.readTool;native.connection.readTool=async(name,args)=>{const values=await readNative(name,args);if(name==='listJiraIssueComments'&&args.startAt===1)for(const v of values)for(const c of v.comments)c.parentId=1;return values;};const nativeBundle=await native.manager.sync(ticket,{force:true});check(nativeBundle.comments.filter(c=>c.id==='2').every(c=>c.parentId==='1')&&native.writes.length===0,'numeric native parent IDs survive full read and cache without Jira mutation');
 const newer=comment('4','',7);groups=api.jiraCommentThreads([...rows,newer]);check(ids(groups)[0]==='1','a new reply moves its whole conversation ahead of a newer standalone original');
 check(ids(api.jiraCommentThreads([...rows,newer],[...rows,newer],'asc'))[0]==='1','oldest conversation order uses original creation');
 const chain=[comment('3','2',3),comment('2','1',2),comment('1','',1)];groups=api.jiraCommentThreads(chain);check(groups[0].rows.map(r=>r.depth).join(',')==='0,1,2'&&groups[0].rows[2].parent.id==='2','nested replies keep direct-parent context');
 const orphan=[comment('3','99',3),comment('2','99',2)];groups=api.jiraCommentThreads(orphan);check(groups.length===1&&groups[0].missingParent&&ids(groups).join(',')==='2,3','missing original is explicitly unavailable and siblings stay together');
 groups=api.jiraCommentThreads([comment('1'),comment('2','1',1,'EXAMPLE-3')]);check(groups.length===2&&groups.some(g=>g.missingParent),'same comment ID in a different issue never supplies a parent');
 groups=api.jiraCommentThreads([comment('1','2'),comment('2','1',1),comment('3','3',2)]);check(new Set(ids(groups)).size===3&&groups.some(g=>g.invalidParent),'cycles and self-links remain visible and terminate');
 check(api.jiraCommentThreads(rows,[]).length===0,'empty scope cannot show conversations');
 groups=api.jiraCommentThreads(rows,[rows[0]]);check(groups[0].matchedCount===1&&groups[0].rows[0].contextOnly&&!groups[0].rows[1].contextOnly,'reply search includes original with explicit non-matching context');
 const long=Array.from({length:3000},(_,i)=>comment(String(i+1),i?String(i):'',i));check(ids(api.jiraCommentThreads(long)).length===3000,'deep imported relations do not recurse or lose comments');
 const {view}=viewFor(rows);view.drawEventList();let cards=elements(view.eventsEl,e=>e.tagName==='article');
 check(cards.map(e=>e.attrs['data-comment-id']).join(',')==='1,2,3','real modal renderer displays original above replies');
 check(elements(view.eventsEl,e=>hasClass(e,'snm-jira-thread')).length===1&&elements(view.eventsEl,e=>hasClass(e,'snm-jira-replies')).length===1,'renderer groups conversation and connector region');
 check(hasClass(cards[1],'snm-jira-comment-reply')&&cards[1].attrs['data-parent-comment-id']==='1','reply styling carries exact parent identity');
 check(cards[1].textContent.includes('Original author에게 답글')&&!cards[1].textContent.includes('상위 댓글 1'),'human-readable parent context replaces isolated numeric reference');
 check(view.pager.textContent.includes('댓글 3개 · 대화 1개'),'pager distinguishes comment count from conversation count');
 let target=null;view.openComposer=e=>target=e;elements(cards[1],e=>e.tagName==='button'&&e.text==='댓글 달기')[0].listeners.click();check(target.id==='2'&&target.issueId==='2','reply action retains clicked comment and its exact source issue');
 view.filter.query='Comment 2';view.drawEventList();cards=elements(view.eventsEl,e=>e.tagName==='article');check(cards.length===3&&cards[0].textContent.includes('대화 맥락'),'filtered reply retains clearly labeled conversation context');
 view.filter.from='2026-10-31';view.drawEventList();check(!elements(view.eventsEl,e=>e.tagName==='article').length,'date filters with no matching comment remain empty');
 view.filter.from='';view.filter.query='';view.commentKeys=new Set();view.drawEventList();check(!elements(view.eventsEl,e=>e.tagName==='article').length,'issue selection excludes entire conversations');
 view.commentKeys=null;view.filter.language='ko';const key=JSON.parse(view.translationKey());check(key.slice(3).map(a=>a[1]).join(',')==='1,2,3','automatic translations cover exactly the grouped visible page');
 const restricted=comment('2','1',5);restricted.jsdPublic=false;const r=viewFor([comment('1'),restricted]).view;r.drawEventList();check(r.eventsEl.textContent.includes('내부/제한 · 공유 전 확인'),'reply restriction warning is not lost inside a thread');
 const many=Array.from({length:51},(_,i)=>comment('root-'+i,'',i));many.push(comment('last-reply','root-0',60));const p=viewFor(many).view;let page=p.commentPage();check(page.current.length===49&&page.rows.length===50&&page.rows.some(e=>e.id==='last-reply'),'whole conversations share the existing 50-comment budget without splitting replies');p.page=1;const second=p.commentPage();check(second.rows.length===2&&!second.rows.some(e=>e.id==='last-reply'),'other page contains no duplicate or detached reply');
 const large=viewFor([comment('root'),...Array.from({length:55},(_,i)=>comment('reply-'+i,'root',i+2)),comment('other','',1)]).view;const largePage=large.commentPage();check(largePage.current.length===1&&largePage.rows.length===56&&largePage.last===1,'a larger conversation is intact on its own page, not multiplied by 50 conversations');
 const draftView=viewFor(rows).view;const editor=draftView.composerEl=draftView.eventsEl.createDiv(),input=editor.createEl('textarea');input.value='unsent draft';input.selectionStart=2;input.selectionEnd=5;input.focus();draftView.composing=true;draftView.draftTarget='EXAMPLE-2';draftView.replyContext={commentId:'2',issueKey:'EXAMPLE-2'};draftView.drawEventList();const parentCard=elements(draftView.eventsEl,e=>e.attrs['data-comment-id']==='2')[0];check(parentCard.contains(editor)&&input.value==='unsent draft'&&input.selectionStart===2&&input.selectionEnd===5,'regrouping reattaches the same draft editor with caret and selection');
 const css=fs.readFileSync(path.join(__dirname,'../styles.css'),'utf8');check(css.includes('.snm-jira-replies')&&css.includes('border-inline-start: 2px')&&css.includes('.snm-jira-comment-reply::before'),'reply connector and theme-aware styling are present');check(css.includes('.snm-jira-comment-reply { margin-inline-start: 0; }'),'narrow screens cap reply indentation');
 console.log('PASS Jira comment threads: '+checks+' checks; parent/reply order, issue isolation, missing/cyclic data, filters, whole-conversation paging, translation page, actual modal DOM, draft preservation and responsive styles. No live writes.');
})().catch(error=>{console.error(error);process.exit(1)});

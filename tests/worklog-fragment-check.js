const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
const code=source.slice(source.indexOf('class TicketWorkLogSourceRenderChild'),source.indexOf('class TicketWorkLogRenderChild'));
const root=new EventTarget(),events=[];
const element={closest:s=>s==='.markdown-preview-section'?root:null};
let reads=0,resolvePending;
const plugin={app:{vault:{cachedRead:async()=>{reads++;return 'record';}}},decorateTicketWorkLogSource:(el,ctx,md,rows,id,p)=>events.push({el,ctx,md,rows,id,p})};
const context=vm.createContext({MarkdownRenderChild:class{constructor(el){this.containerEl=el;this.disposers=[];}registerDomEvent(el,name,fn){el.addEventListener(name,fn);this.disposers.push(()=>el.removeEventListener(name,fn));}},extractTicketWorkLogs:md=>[md]});
vm.runInContext(code+';this.View=TicketWorkLogSourceRenderChild',context);
(async()=>{
 const ctx={getSectionInfo:()=>({lineStart:1,lineEnd:2})};
 const view=new context.View(element,plugin,{path:'Work/CR0000000.md'},'CR0000000',ctx);
 view.onload();await new Promise(r=>setImmediate(r));assert.equal(events.length,1);assert.equal(events[0].ctx,ctx);
 root.dispatchEvent(new Event('clt-worklog-ready'));await new Promise(r=>setImmediate(r));assert.equal(events.length,2);assert.equal(events[1].ctx,ctx);
 plugin.app.vault.cachedRead=()=>new Promise(r=>resolvePending=r);const pending=view.render();view.onunload();view.disposers.forEach(fn=>fn());resolvePending('late');await pending;assert.equal(events.length,2);
 root.dispatchEvent(new Event('clt-worklog-ready'));assert.equal(events.length,2);
 assert(source.includes('ctx.addChild(new TicketWorkLogSourceRenderChild(el, this, file, ticketId, ctx))'));
 console.log('PASS worklog source fragments: own context, ready retry, late read/unload and managed listener cleanup');
})().catch(e=>{console.error(e);process.exit(1)});

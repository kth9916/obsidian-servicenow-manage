const {chromium}=require('playwright'),fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
(async()=>{
 const browser=await chromium.launch({headless:true}),page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8').split('// BEGIN TRANSLATION BUDGET')[1].split('// END TRANSLATION BUDGET')[0];
 await page.setContent('<main id="settings"></main>');
 await page.addStyleTag({content:fs.readFileSync(path.join(__dirname,'../styles.css'),'utf8')});
 await page.addStyleTag({content:'body{margin:16px;font:14px "Malgun Gothic",sans-serif;background:#faf6e6;--background-modifier-border:#ddd}main{max-width:850px;margin:auto}input,button{padding:8px;box-sizing:border-box;font:inherit}button{cursor:pointer}p{line-height:1.6}.mod-cta{background:#ae8cff}'});
 await page.addScriptTag({content:`
 HTMLElement.prototype.createEl=function(tag,o={}){const e=document.createElement(tag);if(o.text)e.textContent=o.text;if(o.cls)e.className=o.cls;for(const [k,v]of Object.entries(o.attr||{}))e.setAttribute(k,v);this.append(e);return e};
 HTMLElement.prototype.createDiv=function(o){return this.createEl('div',o)};HTMLElement.prototype.createSpan=function(o){return this.createEl('span',o)};HTMLElement.prototype.setText=function(t){this.textContent=t};HTMLElement.prototype.empty=function(){this.replaceChildren()};
 ${source}
 const files=new Map();const plugin={manifest:{dir:'test'},app:{vault:{adapter:{exists:async p=>files.has(p),read:async p=>files.get(p),write:async(p,v)=>files.set(p,v)}}}};
 const budget=new TranslationBudget(plugin,()=>new Date('2026-11-16T00:00:00Z'),()=>{});plugin.getTranslationBudget=()=>budget;renderTranslationBudgetSettings(document.querySelector('#settings'),plugin);`});
 await page.getByRole('button',{name:'한도 저장',exact:true}).waitFor();
 await page.getByLabel('미집계 범위와 입력값을 확인했습니다').check();await page.getByRole('button',{name:'이전 사용량 반영'}).click();
 await page.getByLabel('월 최대 문자 수',{exact:true}).fill('500000');await page.getByRole('button',{name:'한도 저장',exact:true}).click();
 await page.getByRole('status').filter({hasText:'500,000'}).waitFor();
 const out=path.join(os.tmpdir(),'snm-translation-budget-qa');fs.mkdirSync(out,{recursive:true});
 for(const [width,height]of [[1440,900],[800,650],[480,720]]){await page.setViewportSize({width,height});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no overflow');await page.screenshot({path:path.join(out,width+'.png'),fullPage:true});}
 assert.deepEqual(errors,[]);console.log('Translation budget UI save and responsive checks passed: '+out);await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});

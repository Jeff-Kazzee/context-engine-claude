import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

function fixture() {
  const source=fs.readFileSync(new URL('../context-engine-trigger/hooks/register.ts',import.meta.url),'utf8');
  const erased=stripTypeScriptTypes(source).replace(/^import[^\n]+\n/gm,'').replace('export const register','const register');const register=new Function(`${erased};return register;`)();
  const hooks=new Map<string,any>();register((name:string,fn:any)=>hooks.set(name,fn));const timers:Array<()=>Promise<void>>=[];let compacted=0,transition:(()=>Promise<void>)|undefined;
  const $={plugin:{root:'/checkout/adapters/claude/context-engine-trigger'},clock:{after:(_delay:number,fn:any)=>{timers.push(fn);}},prompt:{compose:async()=>{await transition?.();return {sections:[{id:'context-engine:working-context'}]};}},session:{root:async()=>'/proj',compact:async()=>{compacted++;}},process:{run:async()=>({exitCode:0,stdout:'{"claude":{"active":true}}'})},ui:{log:()=>{}}};
  const invoke=(name:string,e:any={})=>hooks.get(name)?.($,e,async(v:any)=>v);const start=async()=>{await invoke('session.start',{isInteractive:true});await invoke('prompt.compose',{});};
  return {start,invoke,timers,compacted:()=>compacted,setTransition:(fn:()=>Promise<void>)=>{transition=fn;}};
}
for(const transition of ['end','start','during-compose'])test('wave13: delayed trigger invalidated '+transition,async()=>{
  const w=fixture();await w.start();await w.invoke('turn.complete',{});assert.equal(w.timers.length,1);
  if(transition==='end')await w.invoke('session.end');else if(transition==='start')await w.start();else w.setTransition(()=>w.start());
  await w.timers[0]!();assert.equal(w.compacted(),0);
});
test('wave13: unchanged originating session still compacts',async()=>{const w=fixture();await w.start();await w.invoke('turn.complete',{});await w.timers[0]!();assert.equal(w.compacted(),1);});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tempDir} from '../core/testing.ts';
import {acquireSetupLock} from './files.ts';
import {takeSnapshot,completeLedger,rollbackSnapshot,revert} from './ledger.ts';

test('wave29: setup lock unlink flushes its verified parent',()=>{
 const root=tempDir('setup-release'),path=join(root,'setup','runner.lock'),release=acquireSetupLock(path),unlink=fs.unlinkSync,flush=fs.fsyncSync,order:string[]=[];
 fs.unlinkSync=((p:any)=>{order.push('unlink');return unlink(p);}) as typeof fs.unlinkSync;
 fs.fsyncSync=((fd:number)=>{order.push('flush:'+fs.realpathSync(`/proc/self/fd/${fd}`));return flush(fd);}) as typeof fs.fsyncSync;syncBuiltinESMExports();
 try{release();}finally{fs.unlinkSync=unlink;fs.fsyncSync=flush;syncBuiltinESMExports();}
 assert.deepEqual(order,['unlink','flush:'+join(root,'setup')]);assert.equal(fs.existsSync(path),false);
});
for(const operation of ['rollback','revert'])test('wave29: '+operation+' empty-directory removal stays on its verified parent',()=>{
 const root=tempDir('directory-race'),parent=join(root,'plugins'),namespace=join(parent,'context-engine'),owned=join(namespace,'empty'),outside=join(root,'outside'),moved=join(root,'original');fs.mkdirSync(namespace,{recursive:true});fs.mkdirSync(join(outside,'context-engine','empty'),{recursive:true});
 const snap=takeSnapshot({backupRoot:join(root,'backups'),kind:'empty',files:[],watch:[parent],namespaced:[namespace]});fs.mkdirSync(owned);const ledger=completeLedger(snap),native=fs.rmdirSync;let swapped=false;
 fs.rmdirSync=((path:any)=>{if(!swapped&&String(path).endsWith('/empty')){swapped=true;fs.renameSync(parent,moved);fs.symlinkSync(outside,parent);}return native(path);}) as typeof fs.rmdirSync;syncBuiltinESMExports();
 try{try{operation==='rollback'?rollbackSnapshot(snap,{}):revert(ledger,{},{});}catch(error){assert.match(String(error),/linked|changed|verify/);}}finally{fs.rmdirSync=native;syncBuiltinESMExports();}
 assert.equal(swapped,true);assert.equal(fs.existsSync(join(outside,'context-engine','empty')),true);
});

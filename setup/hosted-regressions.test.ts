
// New hosted-review regressions use scratch homes and synthetic config only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { world, tree } from './testing/world.ts';
import { takeSnapshot, rollbackSnapshot, completeLedger } from './ledger.ts';
const runtime: string = 'claude';
test('rollback without a managed-field rule retains concurrent opaque bytes', () => {
  const w=world(), path=join(w.claudeHome,'opaque.txt');
  writeFileSync(path,'BEFORE');
  const snapshot=takeSnapshot({backupRoot:join(w.stateDir,'backups'),kind:'opaque',files:[path],watch:[],namespaced:[]});
  writeFileSync(path,'CONCURRENT'); rollbackSnapshot(snapshot,{});
  assert.equal(readFileSync(path,'utf8'),'CONCURRENT');
});
test('linked install pointer refuses before runner commands or target creation', () => {
  const w = world(); mkdirSync(join(w.stateDir, 'setup'), { recursive: true, mode: 0o700 });
  const target = join(runtime === 'claude' ? w.codexHome : w.claudeHome, 'unowned-config.json');
  const pointer = join(w.stateDir, 'setup', `${runtime}.json`);
  symlinkSync(target, pointer);
  const beforeClaude = tree(w.claudeHome), beforeCodex = tree(w.codexHome);
  const r = w.ce(['install']); assert.equal(r.status, 1); assert.match(r.stderr, /linked/);
  assert.equal(existsSync(target), false);
  assert.deepEqual(tree(w.claudeHome), beforeClaude); assert.deepEqual(tree(w.codexHome), beforeCodex);
});
for (const action of ['rollback', 'complete']) test(`${action} retains unowned empty directories`, () => {
  const w = world(), owned = join(w.stateDir, 'watched', 'owned'), unowned = join(w.stateDir, 'watched', 'another-plugin');
  mkdirSync(join(w.stateDir, 'watched'), { recursive: true });
  const snapshot = takeSnapshot({ backupRoot: join(w.stateDir, 'backups'), kind: 'test', files: [], watch: [join(w.stateDir, 'watched')], namespaced: [owned] });
  mkdirSync(owned); mkdirSync(unowned);
  if (action === 'rollback') { rollbackSnapshot(snapshot, {}); assert.equal(existsSync(owned), false); }
  else assert.deepEqual(completeLedger(snapshot).createdDirs, [owned]);
  assert.equal(existsSync(unowned), true);
});

import { readFileSync, writeFileSync } from 'node:fs';
import { install, uninstall } from './install.ts';
import { setupContext } from './runners.ts';
import { jsonRule } from './rules.ts';
test('already-installed recovery names this runtime CLI', () => {
  const w = world(); assert.equal(w.ce(['install']).status, 0);
  const again = w.ce(['install']); assert.equal(again.status, 1);
  assert.ok(again.stderr.includes('context-engine-' + runtime + ' uninstall'));
});
test('reverse JSON edit restores a preexisting managed leaf alongside new user settings', () => {
  const rule = jsonRule([['enabledPlugins','ce@ce']]);
  const before = JSON.stringify({enabledPlugins:{'ce@ce': false}, theme:'dark'});
  const now = JSON.stringify({enabledPlugins:{'ce@ce':true}, theme:'light'});
  assert.deepEqual(JSON.parse(rule.strip(now,before)), {enabledPlugins:{'ce@ce':false},theme:'light'});
});
test('uninstall preserves unrelated configuration changed during runner removal', () => {
  const w=world(), config=join(w.claudeHome,'synthetic.json');
  writeFileSync(config, JSON.stringify({theme:'before', owned:false}));
  const ctx={...setupContext(w.env),setupDir:join(w.stateDir,'setup')};
  const rule=jsonRule([['owned']]);
  const script="const fs=require('node:fs'); const p=process.argv[1]; const x=JSON.parse(fs.readFileSync(p,'utf8')); x.theme='concurrent'; delete x.owned; fs.writeFileSync(p,JSON.stringify(x));";
  const spec:any={id:runtime,title:'Synthetic',bin:process.execPath,files:[config],watch:[],namespaced:[],rules:{[config]:rule},install:[],uninstall:[['-e',script,config]],prepare(){writeFileSync(config,JSON.stringify({theme:'before',owned:true}));}};
  install(ctx,spec); uninstall(ctx,spec);
  assert.deepEqual(JSON.parse(readFileSync(config,'utf8')), {theme:'concurrent',owned:false});
});

import { chmodSync, statSync } from 'node:fs';
test('setup refuses an existing nonprivate state root before changing runner homes or publishing participation', () => {
  const w=world();mkdirSync(w.stateDir,{mode:0o755});chmodSync(w.stateDir,0o755);
  const beforeClaude=tree(w.claudeHome),beforeCodex=tree(w.codexHome);
  const r=w.ce(['install']);assert.equal(r.status,1);assert.match(r.stderr,/private|0700/i);
  assert.equal(statSync(w.stateDir).mode&0o777,0o755);
  assert.deepEqual(tree(w.claudeHome),beforeClaude);assert.deepEqual(tree(w.codexHome),beforeCodex);
  const enable=w.ce(['enable']);assert.equal(enable.status,1);assert.deepEqual(tree(w.stateDir),{});
});
test('failed install rollback preserves concurrent unmanaged JSON settings', () => {
  const w=world(),config=join(w.claudeHome,'synthetic-config.json');writeFileSync(config,JSON.stringify({theme:'before',owned:false}));
  const ctx={...setupContext(w.env),setupDir:join(w.stateDir,'setup')};
  const spec:any={id:runtime,title:'Synthetic',bin:process.execPath,files:[config],watch:[],namespaced:[],rules:{[config]:jsonRule([['owned']])},install:[],prepare(){writeFileSync(config,JSON.stringify({theme:'concurrent',owned:true}));throw new Error('synthetic installation failure');}};
  assert.throws(()=>install(ctx,spec),/synthetic installation failure/);
  assert.deepEqual(JSON.parse(readFileSync(config,'utf8')),{theme:'concurrent',owned:false});
});

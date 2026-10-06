import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { world, tree } from './testing/world.ts';
const runtime: string = 'claude';
test('default install and uninstall change only the selected runner and restore exact bytes', () => {
  const w = world();
  writeFileSync(join(w.claudeHome, 'settings.json'), '{"theme":"dark"}\n');
  writeFileSync(join(w.codexHome, 'config.toml'), '# retain this comment\nmodel = "test"\n');
  const beforeClaude = tree(w.claudeHome), beforeCodex = tree(w.codexHome);
  const inst = w.ce(['install']); assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  if (runtime === 'claude') assert.deepEqual(tree(w.codexHome), beforeCodex);
  else assert.deepEqual(tree(w.claudeHome), beforeClaude);
  // A stale other-runner ledger must not be read or acted on by this distribution.
  writeFileSync(join(w.stateDir,'setup','codex.json'),'invalid-other-runner-ledger');
  mkdirSync(join(w.stateDir,'setup','projects'),{recursive:true});
  writeFileSync(join(w.stateDir,'setup','projects','sibling.json'),'invalid-sibling-project-ledger');
  mkdirSync(join(w.project,'.codex'),{recursive:true});
  writeFileSync(join(w.project,'.codex','config.toml'),'# sibling settings must stay\n');
  const projectBefore=tree(w.project);
  const enabled = w.ce(['enable']); assert.equal(enabled.status, 0, enabled.stdout + enabled.stderr);
  if (runtime === 'claude') assert.deepEqual(tree(w.project),projectBefore);
  const status = w.ce(['status']); assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.equal(w.ce(['disable']).status, 0);
  assert.equal(w.ce(['uninstall']).status, 0);
  const afterClaude = tree(w.claudeHome);
  for (const [path, bytes] of Object.entries(beforeClaude)) assert.equal(afterClaude[path], bytes, path);
  assert.equal(existsSync(join(w.claudeHome, 'plugins', 'cache', 'context-engine')), false);
  assert.deepEqual(tree(w.codexHome), beforeCodex);
  assert.deepEqual(tree(w.project),projectBefore);
  assert.equal(readFileSync(join(w.stateDir,'setup','projects','sibling.json'),'utf8'),'invalid-sibling-project-ledger');
});
test('wrong runner install refuses before changing either home', () => {
 const w = world(); const a=tree(w.claudeHome), b=tree(w.codexHome);
 const r=w.ce(['install', '--codex']); assert.equal(r.status,1);assert.match(r.stderr,/supports claude only/);
 assert.deepEqual(tree(w.claudeHome),a); assert.deepEqual(tree(w.codexHome),b);
});
test('shared core hashes match the pinned source manifest', async () => {
 const {createHash}=await import('node:crypto');
 const root=new URL('../',import.meta.url); const source=JSON.parse(readFileSync(new URL('SOURCE.json',root),'utf8'));
 for(const [path,sha] of Object.entries(source.coreSha256)) assert.equal(createHash('sha256').update(readFileSync(new URL(path,root))).digest('hex'),sha,path);
});

test('failed installation restores both runner homes and can be retried', () => {
 const w=world(); writeFileSync(join(w.claudeHome,'settings.json'),'{}\n'); writeFileSync(join(w.codexHome,'config.toml'),'# keep\n');
 const a=tree(w.claudeHome),b=tree(w.codexHome);
 const r=w.ce(['install'],{env:{FAKE_CLAUDE_FAIL: 'plugin install'}});
 assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stderr,/tracked configuration restored/);
 const after=tree(w.claudeHome); for(const [path,bytes] of Object.entries(a)) assert.equal(after[path],bytes,path);
 assert.equal(existsSync(join(w.claudeHome,'plugins','cache','context-engine')),false);assert.deepEqual(tree(w.codexHome),b);
 assert.equal(w.ce(['install']).status,0);assert.equal(w.ce(['install']).status,1);assert.equal(w.ce(['uninstall']).status,0);
});

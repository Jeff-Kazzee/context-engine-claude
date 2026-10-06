import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { cite, openSession, readWorkingContext, recall, show, setParticipation, participation } from './index.ts';
import { atomicWrite, resolveStateRoot } from './store.ts';
import { fixture, tempDir } from './testing.ts';

test('structured command output stays recallable after Working Context replacement', () => {
  const f = fixture(), opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 100000 });
  assert.equal(opened.status, 'open');
  const s = opened.session;
  s.record([{ role: 'tool', text: '$ test (exit 0)', item: { type: 'commandExecution', aggregatedOutput: 'SYNTHETIC_COMMAND_EVIDENCE' } }]);
  assert.doesNotMatch(fs.readFileSync(s.workingContextPath, 'utf8'), /SYNTHETIC_COMMAND_EVIDENCE/);
  fs.writeFileSync(s.workingContextPath, '# user\nNew context'); s.sync(); s.close();
  assert.equal(recall({ ...f, sessionId: 'S1', query: 'SYNTHETIC_COMMAND_EVIDENCE' }).hits[0]?.id, 'e1');
  assert.match(show({ ...f, sessionId: 'S1', id: 'e1' }).text, /SYNTHETIC_COMMAND_EVIDENCE/);
});

test('paged read refuses invalid UTF-8 and preserves a valid BOM byte for byte', () => {
  const f = fixture(), opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 100000 });
  assert.equal(opened.status, 'open'); const path = opened.session.workingContextPath; opened.session.close();
  fs.writeFileSync(path, Buffer.from([0xc3, 0x28]));
  assert.throws(() => readWorkingContext({ ...f, sessionId: 'S1' }), /encoded data|encoding/i);
  const bytes = Buffer.from('\ufeff# user\nBOM preserved'); fs.writeFileSync(path, bytes);
  const result = readWorkingContext({ ...f, sessionId: 'S1' });
  assert.ok(Buffer.from(result.text.slice(result.text.indexOf('\n') + 1)).equals(bytes));
});

test('relative explicit and environment state roots refuse before any state write', () => {
  assert.throws(() => resolveStateRoot('.state'), /absolute/);
  const previous = process.env.CONTEXT_ENGINE_STATE_DIR;
  try { process.env.CONTEXT_ENGINE_STATE_DIR = '.state'; assert.throws(() => resolveStateRoot(), /absolute/); }
  finally { if (previous === undefined) delete process.env.CONTEXT_ENGINE_STATE_DIR; else process.env.CONTEXT_ENGINE_STATE_DIR = previous; }
  const absolute = resolve(tempDir('state')); assert.equal(resolveStateRoot(absolute), absolute);
});

for (const name of ['.env', '.env.production', '.npmrc', '.pypirc', '.aws/credentials', '.ssh/id_ed25519', '.gnupg/private-keys-v1.d/key', '.codex/auth.json', '.claude/.credentials.json']) test(`cite refuses synthetic project credential location ${name} before reading`, () => {
  const f = fixture(), path = join(f.projectRoot, name);
  fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, 'SYNTHETIC_ONLY');
  const native = fs.readFileSync; let read = false;
  try {
    fs.readFileSync = ((fd: any, ...args: any[]) => {
      if (typeof fd === 'number' && fs.realpathSync(`/proc/self/fd/${fd}`) === path) read = true;
      return (native as any)(fd, ...args);
    }) as typeof fs.readFileSync; syncBuiltinESMExports();
    assert.throws(() => cite(f.projectRoot, name), /credential/); assert.equal(read, false);
  } finally { fs.readFileSync = native; syncBuiltinESMExports(); }
});

test('multipart read requires its first content digest and refuses a changed file', () => {
  const f = fixture(), opened = openSession({ ...f, sessionId: 'S1', runner: 'test', hardLimit: 200000 });
  assert.equal(opened.status, 'open');
  try {
    opened.session.record([{ role: 'user', text: 'A'.repeat(40000) }]);
    const first = readWorkingContext({ ...f, sessionId: 'S1' }); assert.equal(first.parts, 2);
    assert.match(first.sha, /^[a-f0-9]{64}$/);
    assert.throws(() => readWorkingContext({ ...f, sessionId: 'S1', part: 2 }), /digest|sha/);
    assert.equal(readWorkingContext({ ...f, sessionId: 'S1', part: 2, sha: first.sha }).part, 2);
    const path = opened.session.workingContextPath;
    fs.writeFileSync(path, fs.readFileSync(path, 'utf8').replaceAll('A', 'B'));
    assert.throws(() => readWorkingContext({ ...f, sessionId: 'S1', part: 2, sha: first.sha }), /changed.*restart/i);
  } finally { opened.session.close(); }
});

test('same-process interleaved participation writes use unique exclusive temporaries', () => {
  const f = fixture(), native = fs.writeFileSync; const paths: string[] = []; let inner = false;
  try {
    fs.writeFileSync = ((path: any, data: any, options: any) => {
      if (String(path).endsWith('.tmp')) {
        paths.push(String(path)); assert.equal(options.flag, 'wx');
        native(path, data, options);
        if (!inner) { inner = true; setParticipation({ ...f, state: 'off' }); }
        return;
      }
      return native(path, data, options);
    }) as typeof fs.writeFileSync; syncBuiltinESMExports();
    setParticipation({ ...f, state: 'on' });
    assert.equal(new Set(paths).size, 2); assert.equal(participation({ ...f, env: {} }).state, 'on');
  } finally { fs.writeFileSync = native; syncBuiltinESMExports(); }
});

test('atomic publication completes repeated short writes without truncation', () => {
  const path = join(tempDir('short-write'), 'snapshot');
  const native = fs.writeSync; const expected = '€漢字'.repeat(40); let calls = 0;
  try {
    fs.writeSync = ((fd: number, bytes: Uint8Array, offset: number, length: number) => {
      calls++; return native(fd, bytes, offset, Math.min(7, length));
    }) as typeof fs.writeSync; syncBuiltinESMExports();
    atomicWrite(path, expected, 'snapshot-tmp');
    assert.equal(fs.readFileSync(path, 'utf8'), expected); assert.ok(calls > 1);
  } finally { fs.writeSync = native; syncBuiltinESMExports(); }
});
test('zero-progress writes refuse publication and keep the prior snapshot', () => {
  const path = join(tempDir('zero-write'), 'snapshot'); fs.writeFileSync(path, 'prior');
  const native = fs.writeSync;
  try {
    fs.writeSync = (() => 0) as typeof fs.writeSync; syncBuiltinESMExports();
    assert.throws(() => atomicWrite(path, 'replacement', 'snapshot-tmp'), /no progress/);
    assert.equal(fs.readFileSync(path, 'utf8'), 'prior');
  } finally { fs.writeSync = native; syncBuiltinESMExports(); }
});

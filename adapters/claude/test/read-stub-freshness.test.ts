// Executes the real register module against the real core CLI in scratch directories.
// Native hook loading is checked separately by `claude plugin test`.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as adapter from '../context-engine/hooks/adapter.ts';
import * as perStep from '../context-engine/hooks/per-step.ts';
import { fixture as scratch } from '../../../core/testing.ts';

const CLI = fileURLToPath(new URL('../../../core/cli.ts', import.meta.url));
const SESSION = 'S1';
const RESTORED = /edit was not applied/;
const COMMITTED = /edit committed as revision/;

type Handler = (host: unknown, event: Record<string, unknown>, next: (event: any) => any) => any;
type ReadOptions = { agentId?: string; failed?: boolean; startLine?: number; limit?: number; during?: () => void };

/** The host's structured Read record (FileReadOutput). A whole-file read returns the exact file text. */
function readRecord(path: string, text: string, startLine = 1, limit?: number) {
  const lines = text.split('\n');
  const totalLines = text.endsWith('\n') ? lines.length - 1 : lines.length;
  const numLines = Math.min(limit ?? totalLines, totalLines - startLine + 1);
  const end = startLine - 1 + numLines;
  const content = lines.slice(startLine - 1, end).join('\n') + (end < lines.length - 1 || text.endsWith('\n') ? '\n' : '');
  return { type: 'text', file: { filePath: path, content, numLines, startLine, totalLines } };
}

function world(t: TestContext, opts: { perStep?: boolean } = {}) {
  const { stateDir, projectRoot } = scratch();
  t.after(() => {
    rmSync(dirname(stateDir), { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });
  const env = { ...process.env, CONTEXT_ENGINE_STATE_DIR: stateDir, XDG_STATE_HOME: '/nonexistent-should-not-be-used', CONTEXT_ENGINE: '', CONTEXT_ENGINE_EXPERIMENTS: '', CONTEXT_ENGINE_TEST_PROJECT: '' };
  const run = (args: string[], stdin?: string) => {
    const r = spawnSync(process.execPath, args, { cwd: projectRoot, input: stdin, encoding: 'utf8', env });
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  const enabled = run([CLI, 'enable']);
  assert.equal(enabled.exitCode, 0, enabled.stdout + enabled.stderr);

  const source = readFileSync(new URL('../context-engine/hooks/register.ts', import.meta.url), 'utf8');
  const erased = stripTypeScriptTypes(source).replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '').replace('export const register', 'const register');
  const load = new Function('adapterModule', 'stepModule', `const {${Object.keys(adapter).join(',')}} = adapterModule; const {${Object.keys(perStep).filter(k => !(k in adapter)).join(',')}} = stepModule; ${erased}; return register;`);
  const handlers = new Map<string, Handler>();
  load(adapter, perStep)((name: string, ...args: Handler[]) => handlers.set(name, args.at(-1)!), { coreCli: CLI });
  const handler = (name: string) => handlers.get(name)!;

  const commands: string[] = [];
  const steps: string[] = [];
  let messages: adapter.ApiMessage[] = [];
  let natives = 0;
  const host = {
    plugin: { root: '/unused' },
    session: { id: async () => SESSION, root: async () => projectRoot, usage: async () => ({}), messages: async () => messages,
      authorize: async () => ({ handle: 'synthetic-opaque-handle', kind: 'bearer' }) },
    env: { get: async (key: string) => (key === 'CONTEXT_ENGINE_CLAUDE_MODE' && opts.perStep ? 'per-step' : undefined) },
    ui: { log: () => {}, status: () => {} },
    prompt: { compose: async () => ({ sections: [] }) },
    tool: { list: async () => [] },
    http: { fetch: async (_url: string, init: { body?: unknown }) => {
      steps.push(String(init.body));
      return { status: 200, text: JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }) };
    } },
    fs: { write: async () => {} },
    process: { run: async (argv: string[], init: { stdin?: string }) => {
      commands.push(argv[2]!);
      return run(argv.slice(1), init.stdin);
    } },
  };
  const wc = join(projectRoot, '.context-engine', SESSION, 'context.md');
  const call = (event: Record<string, unknown>, result: unknown) => handler('tool.call')(host, event, async () => result);
  return {
    wc, commands, steps, natives: () => natives,
    start: () => handler('session.start')(host, {}, async e => e),
    end: () => handler('session.end')(host, {}, async e => e),
    say(user: string, assistant: string) {
      messages.push({ role: 'user', content: [{ type: 'text', text: user }] }, { role: 'assistant', content: [{ type: 'text', text: assistant }] });
    },
    async compact(): Promise<string> {
      const answer = await handler('session.compact')(host, { trigger: 'plugin' }, async () => { throw new Error('native compaction must not run'); });
      const frame = String(answer.messages?.[0]?.text);
      assert.ok(frame.startsWith(adapter.FRAME_OPEN), frame);
      messages = [{ role: 'user', content: [{ type: 'text', text: frame }] }];
      return frame;
    },
    async step(index: number) {
      const stream = handler('turn.step')(host, { model: 'synthetic', turnId: 't', index }, async function* () { natives++; return {}; });
      for await (const _ of stream) { /* No real model is called. */ }
    },
    failRead: (id: string) => handler('tool.call')(host, { tool: 'Read', file_path: wc, tool_use_id: id }, async () => { throw new Error('synthetic Read failure'); }),
    async append(id: string, content: string): Promise<unknown> {
      const appended = await handler('session.append')(host, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } }, async e => e);
      return appended.message.content[0].content;
    },
    bash: (id: string) => {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'out' }] });
      return call({ tool: 'Bash', command: 'ls', tool_use_id: id }, { text: 'out' });
    },
    /** One Read as the host runs it: the tool reads the file, then its result row is appended. */
    async read(id: string, o: ReadOptions = {}): Promise<{ text: string; shown: unknown }> {
      const record = o.failed ? undefined : readRecord(wc, readFileSync(wc, 'utf8'), o.startLine, o.limit);
      const text = record ? record.file.content : 'File does not exist.';
      const result = record ? { result: record, text } : { text };
      const event = { tool: 'Read', file_path: wc, tool_use_id: id, ...(o.agentId ? { agentId: o.agentId } : {}) };
      const returned = await handler('tool.call')(host, event, async () => { o.during?.(); return result; });
      assert.deepEqual(returned, result);
      const block = { type: 'tool_result', tool_use_id: id, content: text, ...(o.failed ? { is_error: true } : {}) };
      const appended = await handler('session.append')(host, { ...(o.agentId ? { agentId: o.agentId } : {}), message: { role: 'user', content: [block] } }, async e => e);
      return { text, shown: appended.message.content[0].content };
    },
  };
}

test('[CLA-027] a Read after an external edit to the delivered file shows the edited text, not the stub', async t => {
  const w = world(t);
  await w.start();
  w.say('Retain CE_OLD_TEST.', 'CE_OLD_TEST');
  assert.match(await w.compact(), /CE_OLD_TEST/);
  writeFileSync(w.wc, readFileSync(w.wc, 'utf8').replaceAll('CE_OLD_TEST', 'CE_NEW_TEST'));
  const changed = await w.read('r1');
  assert.match(changed.text, /CE_NEW_TEST/);
  assert.equal(changed.shown, changed.text, 'the edited file must not be replaced by a stub pointing at the stale frame');
  w.say('Reply with the retained sentinel.', 'CE_NEW_TEST');
  const next = await w.compact();
  assert.match(next, /CE_NEW_TEST/);
  assert.doesNotMatch(next, /CE_OLD_TEST/);
  assert.equal((await w.read('r2')).shown, adapter.READ_STUB, 'once the next frame holds the edit, a Read of the unchanged file is stubbed again');
  await w.end();
});

test('[CLA-027] a Read of the unchanged delivered file is still stubbed', async t => {
  const w = world(t);
  await w.start();
  w.say('Retain CE_OLD_TEST.', 'CE_OLD_TEST');
  await w.compact();
  const before = w.commands.length;
  const read = await w.read('r1');
  assert.match(read.text, /CE_OLD_TEST/);
  assert.equal(read.shown, adapter.READ_STUB);
  assert.deepEqual(w.commands.slice(before), [], 'deciding the stub costs no core call');
  await w.end();
});

test('[CLA-027] a file edited and then restored to the delivered bytes is stubbed', async t => {
  const w = world(t);
  await w.start();
  w.say('Retain CE_OLD_TEST.', 'CE_OLD_TEST');
  await w.compact();
  const delivered = readFileSync(w.wc, 'utf8');
  writeFileSync(w.wc, delivered.replaceAll('CE_OLD_TEST', 'CE_NEW_TEST'));
  writeFileSync(w.wc, delivered);
  assert.equal((await w.read('r1')).shown, adapter.READ_STUB);
  await w.end();
});

test('[CLA-016] a sub-agent Read is neither synced nor stubbed', async t => {
  const w = world(t);
  await w.start();
  w.say('Retain CE_OLD_TEST.', 'CE_OLD_TEST');
  await w.compact();
  const before = w.commands.length;
  const read = await w.read('a1', { agentId: 'agent-1' });
  assert.equal(read.shown, read.text);
  assert.deepEqual(w.commands.slice(before), []);
  await w.end();
});

test('[CLA-027] a Read before this process has delivered a frame is not stubbed', async t => {
  const w = world(t);
  await w.start();
  writeFileSync(w.wc, '[[CTX_TURN 1 role=user]]\nCE_OLD_TEST\n');
  const read = await w.read('r1');
  assert.equal(read.shown, read.text, 'no <working_context> message holds the file yet');
  await w.end();
});

test('[CORE-006] an emptied file reaches the model as the real Read, and the next frame carries the restore receipt', async t => {
  const w = world(t);
  await w.start();
  w.say('Retain CE_OLD_TEST.', 'CE_OLD_TEST');
  await w.compact();
  writeFileSync(w.wc, '');
  const read = await w.read('r1');
  assert.equal(read.shown, '', 'the empty Read is not replaced by a pointer');
  w.say('next', 'ok');
  assert.match(await w.compact(), RESTORED);
  await w.end();
});

test('[CORE-002] after an external edit the next frame carries the committed receipt', async t => {
  const w = world(t);
  await w.start();
  w.say('Retain CE_OLD_TEST.', 'CE_OLD_TEST');
  await w.compact();
  writeFileSync(w.wc, readFileSync(w.wc, 'utf8').replaceAll('CE_OLD_TEST', 'CE_NEW_TEST'));
  await w.read('r1');
  w.say('next', 'ok');
  assert.match(await w.compact(), COMMITTED);
  await w.end();
});

test('[CORE-006] a deleted file keeps the failed Read, stays absent within the turn, and the next frame carries the restore receipt', async t => {
  const w = world(t);
  await w.start();
  w.say('Retain CE_OLD_TEST.', 'CE_OLD_TEST');
  await w.compact();
  unlinkSync(w.wc);
  const read = await w.read('r1', { failed: true });
  assert.equal(read.shown, 'File does not exist.');
  assert.equal(existsSync(w.wc), false, 'nothing recreates the file before the turn boundary');
  w.say('next', 'ok');
  assert.match(await w.compact(), RESTORED);
  await w.end();
});

test('[CLA-010] in per-step mode an emptied file, a Read and Bash still make the next step stand aside', async t => {
  const w = world(t, { perStep: true });
  await w.start();
  w.say('Retain CE_OLD_TEST.', 'CE_OLD_TEST');
  await w.compact();
  await w.step(1);
  assert.equal(w.natives(), 0);
  writeFileSync(w.wc, '');
  await w.read('r1');
  await w.bash('b1');
  await w.step(2);
  assert.equal(w.steps.length, 1, 'no custom request is built after Bash and an unobserved restore');
  assert.equal(w.natives(), 1, 'Claude Code sends the step itself');
  await w.end();
});

test('[CLA-027] a partial Read of the unchanged delivered file keeps its real result', async t => {
  const w = world(t);
  await w.start();
  w.say('Retain CE_OLD_TEST.', 'CE_OLD_TEST');
  await w.compact();
  const read = await w.read('r1', { startLine: 2 });
  assert.equal(read.shown, read.text);
  await w.end();
});

test('[CLA-027] a Bash that starts while a Read runs leaves that Read unstubbed', async t => {
  const w = world(t);
  await w.start();
  w.say('Retain CE_OLD_TEST.', 'CE_OLD_TEST');
  await w.compact();
  let bash: Promise<unknown> | undefined;
  const read = await w.read('r1', { during: () => { bash = w.bash('b1'); } });
  assert.equal(read.shown, read.text);
  await bash;
  await w.end();
});

test('[CLA-027] a Read limited to the delivered lines of a longer file keeps its real result', async t => {
  const w = world(t);
  await w.start();
  w.say('Retain CE_OLD_TEST.', 'CE_OLD_TEST');
  await w.compact();
  const delivered = readFileSync(w.wc, 'utf8');
  writeFileSync(w.wc, `${delivered}EXTERNAL_LINE\n`);
  const read = await w.read('r1', { limit: delivered.split('\n').length - 1 });
  assert.equal(read.text, delivered);
  assert.equal(read.shown, read.text, 'the file holds more than the frame, so a pointer would hide the extra line');
  await w.end();
});

test('[CLA-027] in per-step mode a Read of text that only a per-step request carried keeps its real result', async t => {
  const w = world(t, { perStep: true });
  await w.start();
  w.say('Retain CE_OLD_TEST.', 'CE_OLD_TEST');
  await w.compact();
  writeFileSync(w.wc, readFileSync(w.wc, 'utf8').replaceAll('CE_OLD_TEST', 'CE_NEW_TEST'));
  await w.step(1);
  assert.equal(w.steps.length, 1);
  const read = await w.read('r1');
  assert.match(read.text, /CE_NEW_TEST/);
  assert.equal(read.shown, read.text, 'the conversation frame still holds CE_OLD_TEST, so a step Claude Code sends itself would see only the stale frame');
  await w.end();
});

test('[CLA-010] in per-step mode Bash after a per-step delivery of the current revision stays recordable', async t => {
  const w = world(t, { perStep: true });
  await w.start();
  w.say('Retain CE_OLD_TEST.', 'CE_OLD_TEST');
  await w.compact();
  writeFileSync(w.wc, readFileSync(w.wc, 'utf8').replaceAll('CE_OLD_TEST', 'CE_NEW_TEST'));
  await w.step(1);
  await w.bash('b1');
  await w.step(2);
  assert.equal(w.steps.length, 2, 'the per-step delivery stays the Bash baseline');
  assert.equal(w.natives(), 0);
  await w.end();
});

test('[CLA-027] a Read whose tool call throws leaves no stub behind', async t => {
  const w = world(t);
  await w.start();
  w.say('Retain CE_OLD_TEST.', 'CE_OLD_TEST');
  await w.compact();
  await assert.rejects(w.failRead('r1'), /synthetic Read failure/);
  assert.equal(await w.append('r1', 'LATER_RESULT_TEXT'), 'LATER_RESULT_TEXT');
  await w.end();
});

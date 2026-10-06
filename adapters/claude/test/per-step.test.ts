// Unit tests for the Claude Code Adapter's experimental per-step mode (V2): the request a
// `turn.step` hook builds from the Working Context and the current turn's tail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiMessage, Block } from '../context-engine/hooks/adapter.ts';
import { compactionText, systemSectionText } from '../context-engine/hooks/adapter.ts';
import { credentialHits } from '../../../setup/testing/credential-scan.ts';
import {
  PER_STEP_STATUS,
  buildStepRequest,
  parseStepResponse,
  perStepOn,
  requestLogPath,
  redact,
  requestLogRecord,
  stepChunks,
  stepFailure,
  stepFetchInit,
} from '../context-engine/hooks/per-step.ts';

const WC = '/proj/.context-engine/S1/context.md';
const KEY = '00112233445566778899aabbccddeeff';
const FILE = '[[CTX_TURN 1 role=user]]\nFACT B: SENTINEL_V2\n\n[[CTX_TURN 2 role=assistant]]\nOK';
const SECTIONS = [
  { id: 'intro', text: 'You are an interactive agent.', scope: 'shared' as const },
  { id: 'env', text: 'Platform: linux', scope: 'session' as const },
];
const OWN = { id: 'context-engine:working-context', text: '# Working Context (Context Engine)', scope: 'session' as const };
const TOOLS = [
  { name: 'Read', description: 'Reads a file.' },
  { name: 'Edit', description: 'Edits a file.' },
];

const user = (...content: Block[]): ApiMessage => ({ role: 'user', content });
const assistant = (...content: Block[]): ApiMessage => ({ role: 'assistant', content });
const text = (t: string): Block => ({ type: 'text', text: t });
const use = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: unknown, isError?: boolean): Block => ({ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) });

const build = (messages: ApiMessage[], over: Partial<Parameters<typeof buildStepRequest>[0]> = {}) =>
  buildStepRequest({ model: 'claude-haiku-4-5', messages, wcPath: WC, frameKey: KEY, fileText: FILE, sections: SECTIONS, ownSection: OWN, tools: TOOLS, ...over });

const all = (body: unknown) => JSON.stringify(body);

test('the Working Context opens the first user message; the system field carries none of it', () => {
  const body = build([user(text('What is the codeword?'))]);
  assert.equal(body.messages[0]!.role, 'user');
  const first = body.messages[0]!.content;
  assert.match(String(first[0]!.text), /^<working_context file="\/proj\/\.context-engine\/S1\/context\.md" delivery="EXPERIMENTAL: Full Replacement per model step" frame="00112233445566778899aabbccddeeff">/);
  assert.match(String(first[0]!.text), /FACT B: SENTINEL_V2/);
  assert.equal(first[1]!.text, 'What is the codeword?');
  assert.ok(!JSON.stringify(body.system).includes('SENTINEL_V2'), 'no file text in system');
  assert.ok(!JSON.stringify(body.system).includes('<working_context'), 'no frame in system');
});

test('rows before the last frame and the stale frame itself are never sent; Claude Code\'s context reminders ahead of it are kept', () => {
  const oldFrame = compactionText(WC, '[[CTX_TURN 1 role=user]]\nFACT A: purple elephant SENTINEL_DELETE_ME', [], 'x', KEY);
  const body = build([
    user(text('FACT A: purple elephant SENTINEL_DELETE_ME')),
    assistant(text('OK')),
    user(text('<system-reminder>\nCLAUDEMD_MARKER\n</system-reminder>'), text(oldFrame), text('Next question')),
  ]);
  assert.ok(!all(body).includes('SENTINEL_DELETE_ME'), 'the deleted sentinel is absent');
  assert.equal(body.messages.length, 1);
  const blocks = body.messages[0]!.content.map((b) => String(b.text));
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0], '<system-reminder>\nCLAUDEMD_MARKER\n</system-reminder>');
  assert.match(blocks[1]!, /^<working_context [^>]*>[\s\S]*SENTINEL_V2[\s\S]*<\/working_context>$/);
  assert.equal(blocks[2], 'Next question');
});

test('tool calls on the Working Context file and their results are stubbed in the request; other tool traffic and its ids are kept', () => {
  const body = build([
    user(text('Edit your Working Context')),
    assistant({ type: 'thinking', thinking: 'secret', signature: 's' }, use('t1', 'Read', { file_path: WC }), use('t2', 'Read', { file_path: '/proj/a.ts' })),
    user(result('t1', '     1\tFACT A: purple elephant SENTINEL_DELETE_ME'), result('t2', [{ type: 'text', text: 'export const a = 1' }])),
    assistant(use('t3', 'Edit', { file_path: WC, old_string: 'FACT A: purple elephant SENTINEL_DELETE_ME\n', new_string: '' })),
    user(result('t3', 'String to replace not found in file.\nString: FACT A: purple elephant SENTINEL_DELETE_ME', true)),
  ]);
  const json = all(body);
  assert.ok(!json.includes('SENTINEL_DELETE_ME'), 'no deleted text through old_string, the Read echo or an error echo');
  assert.ok(!json.includes('"thinking"'), 'thinking is dropped');
  const [, a1, u1, a2, u2] = body.messages;
  assert.deepEqual(
    a1!.content.map((b) => [b.type, b.id, b.name]),
    [
      ['tool_use', 't1', 'Read'],
      ['tool_use', 't2', 'Read'],
    ],
  );
  assert.deepEqual(a1!.content[0]!.input, { file_path: WC });
  assert.deepEqual(a1!.content[1]!.input, { file_path: '/proj/a.ts' });
  assert.equal(u1!.content[0]!.tool_use_id, 't1');
  assert.match(String(u1!.content[0]!.content), /^\(Read of the Working Context file: its current text is the <working_context> message above/);
  assert.deepEqual(u1!.content[1], result('t2', [{ type: 'text', text: 'export const a = 1' }]));
  assert.deepEqual(a2!.content[0]!.input, { file_path: WC, note: 'input elided; the current file is the <working_context> message' });
  assert.equal(u2!.content[0]!.is_error, true);
  assert.match(String(u2!.content[0]!.content), /^\(Working Context file operation failed/);
});

test('a successful edit of the file reads back as applied and already shown in the frame, so the instruction is not redone', () => {
  const body = build([
    user(text('Delete the animal line')),
    assistant(use('t1', 'Edit', { file_path: WC, old_string: 'x', new_string: '' }), use('t2', 'Write', { file_path: WC, content: 'whole file' })),
    user(result('t1', 'The file has been updated.'), result('t2', 'File written.')),
  ]);
  for (const b of body.messages[2]!.content) {
    assert.match(String(b.content), /^\(Working Context edit applied\. The <working_context> message above already shows the file with this edit; do not redo it\.\)$/);
  }
  assert.ok(!all(body).includes('whole file'), "a Write's content is elided too");
});

test('the tail is paired: every tool_result answers a tool_use in the message just before it, results first; strays become text', () => {
  const oldFrame = compactionText(WC, 'old', [], 'x', KEY);
  const body = build([
    user(text(oldFrame), result('x0', 'result of a call made before the frame')),
    assistant(text('a'), use('t1', 'Bash', { command: 'ls' }), use('t2', 'Bash', { command: 'pwd' })),
    user(text('<system-reminder>\ntodo list\n</system-reminder>'), result('t1', 'a.ts')),
    assistant({ type: 'thinking', thinking: 'only thinking', signature: 's' }),
    user(text('go on')),
  ]);
  assert.deepEqual(
    body.messages.map((m) => [m.role, m.content.map((b) => (b.type === 'text' ? `text:${String(b.text).slice(0, 18)}` : `${b.type}:${b.id ?? b.tool_use_id}`))]),
    [
      ['user', ['text:<working_context f', 'text:[tool_result] resu']],
      ['assistant', ['text:a', 'tool_use:t1', 'text:[tool_use Bash] {"']],
      ['user', ['tool_result:t1', 'text:<system-reminder>\n', 'text:go on']],
    ],
  );
});

test('system: the identity line, then the composed shared and session sections, with this mod\'s section once', () => {
  const body = build([user(text('q'))]);
  assert.deepEqual(
    body.system.map((b) => b.text),
    ["You are a coding agent using Context Engine inside Claude Code.", 'You are an interactive agent.', 'Platform: linux\n\n# Working Context (Context Engine)'],
  );
  const again = build([user(text('q'))], { sections: [...SECTIONS, OWN] });
  assert.deepEqual(again.system, body.system, 'a compose result that already carries the section is not doubled');
  assert.deepEqual(body.system.at(-1)!.cache_control, { type: 'ephemeral' });
});

test('cache marks sit after the system prompt, after the Working Context frame and on the last block of the tail', () => {
  const body = build([user(text('q')), assistant(use('t1', 'Bash', { command: 'ls' })), user(result('t1', 'a.ts'))]);
  const marked = [...body.system, ...body.messages.flatMap((m) => m.content)].filter((b) => b.cache_control).map((b) => String(b.text ?? b.type).slice(0, 16));
  assert.deepEqual(marked, ['Platform: linux\n', '<working_context', 'tool_result']);
});

test('compatibility schemas constrain tool arguments without embedding captured runner prose', () => {
  const body = build([user(text('q'))], { tools: ['Read', 'Edit', 'Write', 'Bash'].map(name => ({ name, description: 'Synthetic tool.' })) });
  const schemas = Object.fromEntries(body.tools.map(t => [t.name, t.input_schema])) as Record<string, { type: string; additionalProperties: boolean; properties: Record<string, { type: string; description: string; minimum?: number; exclusiveMinimum?: number; maximum?: number; default?: boolean }> }>;
  for (const schema of Object.values(schemas)) {
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false, 'unknown argument keys are refused');
    for (const field of Object.values(schema.properties)) {
      assert.equal(typeof field.description, 'string');
      assert.ok(field.description.length > 0);
    }
  }
  assert.equal(schemas.Read!.properties.file_path!.type, 'string');
  assert.equal(schemas.Read!.properties.offset!.type, 'integer');
  assert.equal(schemas.Read!.properties.offset!.minimum, 0);
  assert.equal(schemas.Read!.properties.limit!.exclusiveMinimum, 0);
  assert.equal(schemas.Read!.properties.limit!.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(schemas.Edit!.properties.replace_all!.type, 'boolean');
  assert.equal(schemas.Edit!.properties.replace_all!.default, false);
  assert.equal(schemas.Bash!.properties.timeout!.type, 'number');
  assert.equal(schemas.Bash!.properties.run_in_background!.type, 'boolean');
  assert.equal(schemas.Bash!.properties.dangerouslyDisableSandbox!.type, 'boolean');
});

test('tools: real descriptions from the session; independently worded compatibility schemas for Read, Edit, Write and Bash, any other tool an open object', () => {
  const body = build([user(text('q'))], { tools: [...TOOLS, { name: 'Write', description: 'Writes.' }, { name: 'Bash', description: 'Runs.' }, { name: 'mcp__x__y', description: 'Other.' }] });
  assert.deepEqual(
    body.tools.map((t) => [t.name, t.description]),
    [
      ['Read', 'Reads a file.'],
      ['Edit', 'Edits a file.'],
      ['Write', 'Writes.'],
      ['Bash', 'Runs.'],
      ['mcp__x__y', 'Other.'],
    ],
  );
  const schema = (n: string) => body.tools.find((t) => t.name === n)!.input_schema as { required?: string[]; properties?: Record<string, unknown> };
  assert.deepEqual(schema('Read').required, ['file_path']);
  assert.deepEqual(Object.keys(schema('Read').properties!), ['file_path', 'offset', 'limit', 'pages']);
  assert.deepEqual(schema('Edit').required, ['file_path', 'old_string', 'new_string']);
  assert.deepEqual(Object.keys(schema('Edit').properties!), ['file_path', 'old_string', 'new_string', 'replace_all']);
  assert.deepEqual(schema('Write').required, ['file_path', 'content']);
  assert.deepEqual(schema('Bash').required, ['command']);
  assert.deepEqual(schema('mcp__x__y'), { type: 'object', additionalProperties: true });
});

test('a response becomes text, tool and input chunks and a stop chunk carrying its usage, and the step result', () => {
  const { chunks, result: r } = stepChunks(
    {
      model: 'claude-haiku-4-5-20251001',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: WC } },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    },
    { turnId: 'T', index: 2, model: 'haiku' },
  );
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, model: 'claude-haiku-4-5-20251001' };
  assert.deepEqual(chunks, [
    { kind: 'text', index: 0, text: 'Reading.' },
    { kind: 'tool', index: 1, id: 'toolu_1', name: 'Read' },
    { kind: 'input', index: 1, json: JSON.stringify({ file_path: WC }) },
    { kind: 'stop', stopReason: 'tool_use', usage },
  ]);
  assert.deepEqual(r, { turnId: 'T', index: 2, answer: 'Reading.', toolUses: [{ name: 'Read', input: { file_path: WC } }], stopReason: 'tool_use', usage });
});

test('the request log record holds the body, status and usage, never headers or the auth handle, with e-mails and tokens redacted', () => {
  const body = build([user(text('mail me at jeff@example.com, key sk-ant-oat01-SECRET'))]);
  const rec = requestLogRecord({
    at: '2026-10-05T00:00:00.000Z',
    sessionId: 'S1',
    turnId: 'T',
    index: 0,
    revision: 4,
    status: 200,
    ms: 812,
    body,
    response: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 7, output_tokens: 1 } },
  });
  const json = JSON.stringify(rec);
  assert.equal(rec.kind, 'claude-per-step-request');
  assert.equal(rec.mode, 'EXPERIMENTAL: Full Replacement per model step');
  assert.deepEqual(rec.usage, { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.equal(rec.revision, 4);
  assert.ok(!json.includes('jeff@example.com'));
  assert.ok(!json.includes('SECRET'));
  assert.ok(!/authorization|x-api-key|"headers"|"auth"/i.test(json));
  assert.match(json, /SENTINEL_V2/, 'the Working Context the model was sent is kept for the eval');
});

test('per-step mode is off unless CONTEXT_ENGINE_CLAUDE_MODE or the plugin option says per-step; the environment wins', () => {
  assert.equal(perStepOn(undefined, undefined), false);
  assert.equal(perStepOn(undefined, 'turn'), false);
  assert.equal(perStepOn('per-step', undefined), true);
  assert.equal(perStepOn(undefined, 'per-step'), true);
  assert.equal(perStepOn('turn', 'per-step'), false);
  assert.equal(perStepOn('PER-STEP ', undefined), true);
  assert.equal(perStepOn('bogus', undefined), false);
});

test('the per-step label says EXPERIMENTAL and names every gap; the system section states it and per-step timing', () => {
  assert.equal(PER_STEP_STATUS, 'Context Engine: EXPERIMENTAL: Full Replacement per model step (gaps: hand-written tool schemas, reduced system prompt, no streaming, blind cost ledger)');
  const section = systemSectionText(WC, { sessionId: 'S1', staleRefs: false, perStep: true });
  assert.ok(section.includes('Delivery mode: EXPERIMENTAL: Full Replacement per model step'));
  assert.ok(section.includes('hand-written tool schemas, reduced system prompt, no streaming, blind cost ledger'));
  assert.match(section, /before every model step/i);
  assert.match(section, /very next step/);
  assert.ok(!section.includes('Injection within a turn'));
  assert.ok(systemSectionText(WC, { sessionId: 'S1', staleRefs: false }).includes('Injection within a turn'), 'the default section is unchanged');
});

test('sending: the fetch init carries the opaque auth handle and no Authorization header; failures and paths are plain data', () => {
  const body = build([user(text('hi'))]);
  const init = stepFetchInit({ handle: 'opaque-1', kind: 'bearer' }, body);
  assert.equal(init.auth, 'opaque-1');
  assert.equal(init.method, 'POST');
  assert.ok(!Object.keys(init.headers).some((k) => k.toLowerCase() === 'authorization' || k.toLowerCase() === 'x-api-key'));
  assert.equal((init.headers as Record<string, string>)['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal('anthropic-beta' in stepFetchInit({ handle: 'h', kind: 'api-key' }, body).headers, false);
  assert.deepEqual(JSON.parse(init.body), body);

  assert.deepEqual(parseStepResponse('{"content":[]}'), { content: [] });
  assert.deepEqual(parseStepResponse('<html>bad gateway'), { error: '<html>bad gateway' });
  assert.equal(stepFailure(200, { content: [] }), null);
  assert.equal(stepFailure(529, { error: { type: 'overloaded_error' } }), 'HTTP 529: {"type":"overloaded_error"}');
  assert.match(stepFailure(200, { error: 'x' })!, /^HTTP 200/);
  assert.equal(requestLogPath('/state/p/S1', 1700000000000, 'turn/1', 2), '/state/p/S1/claude-per-step/1700000000000-turn_1-2.json');
});

test('a step with nothing after the frame still sends one user message, never an empty one', () => {
  const body = build([user(text(compactionText(WC, 'old', [], 'x', KEY)))]);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0]!.content.length, 1);
});

test('the request log redacts every credential format the Codex evidence redactor covers, bare JWTs included, before it is written', () => {
  // Synthetic credentials only.
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
  const secrets = [
    jwt,
    'sk-proj-abcdefghijklmnopqrstuv',
    'chatgpt-account-id: 3f2a9c1e-0000-4000-8000-000000000000',
    '"account_id": "acct-12345678"',
    'cookie=__cf_bm_abcdefghijklmnop',
    '__Secure-next-auth.session-token=abcdef123456',
    'A'.repeat(90),
  ];
  const body = build([user(text('run it')), assistant(use('t1', 'Bash', { command: 'cat token.txt' })), user(result('t1', secrets.join('\n')))]);
  const rec = requestLogRecord({ at: 'x', sessionId: 'S1', turnId: 'T', index: 0, revision: 1, status: 200, ms: 1, body, response: { content: [{ type: 'text', text: `found ${jwt}` }] } });
  const json = JSON.stringify(rec);
  assert.doesNotMatch(json, /eyJ|abcdefghijklmnopqrstuv|3f2a9c1e|acct-12345678|__cf_bm|session-token=abc|AAAAAAAAAA/);
  assert.match(json, /cat token\.txt/, 'the rest of the request is kept');
  for (const s of secrets) assert.doesNotMatch(redact(s), new RegExp(s.slice(-8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), s);
  // The Codex evidence scanner finds every sample, and nothing once the per-step redactor has run.
  for (const s of secrets) assert.ok(credentialHits(s).length > 0, s);
  assert.deepEqual(credentialHits(json), []);
});

test('a user message quoting a frame does not cut the request: the turn before it is still sent', () => {
  const KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
  const quoted = '<working_context file="/elsewhere/context.md" delivery="x">\nexample\n</working_context>';
  const body = build([user(text(compactionText(WC, 'old', [], 'x', KEY)), text('FACT C: SENTINEL_BEFORE')), assistant(text('noted')), user(text(quoted))], { frameKey: KEY });
  assert.ok(all(body).includes('SENTINEL_BEFORE'), 'the turn before the quoted example is kept');
  assert.ok(all(body).includes('example'), 'the quoted example itself is kept');
});

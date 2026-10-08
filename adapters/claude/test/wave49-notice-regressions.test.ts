// Executes the real register module with local host stand-ins. Native loading is checked separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as adapter from '../context-engine/hooks/adapter.ts';
import * as perStep from '../context-engine/hooks/per-step.ts';
import { prepareWorkingContextDelivery } from '../../../core/delivery.ts';

function fixture() {
  const source = readFileSync(new URL('../context-engine/hooks/register.ts', import.meta.url), 'utf8');
  const erased = stripTypeScriptTypes(source).replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '').replace('export const register', 'const register');
  const load = new Function('adapterModule', 'stepModule', `const {${Object.keys(adapter).join(',')}} = adapterModule; const {${Object.keys(perStep).filter(k => !(k in adapter)).join(',')}} = stepModule; ${erased}; return register;`);
  type Event = Record<string, unknown>;
  type Result = { context?: string[]; text?: string };
  type Handler = (host: unknown, event: Event, next: (event: Event) => Promise<Result>) => Promise<Result>;
  const handlers = new Map<string, Handler>();
  load(adapter, perStep)((name: string, ...args: Handler[]) => handlers.set(name, args.at(-1)!), {});
  let currentTokens = 37_000;
  let edited = true;
  const calls: string[][] = [];
  const text = '[[CTX_TURN 1 role=user]]\nNEW_EDIT_SENTINEL';
  const snapshot = { revision: 2, chars: text.length, workingContextText: text };
  const host = {
    plugin: { root: '/checkout/adapters/claude/context-engine' },
    session: { id: async () => 'S1', root: async () => '/proj', messages: async () => [],
      usage: async () => ({ context: { tokens: currentTokens, breakdown: {
        rawMaxTokens: 100_000, isAutoCompactEnabled: true, autoCompactThreshold: 67_000,
        categories: [{ name: 'System', tokens: 17_000, kind: 'used' }],
      } } }),
    },
    env: { get: async () => undefined },
    ui: { log: () => {}, status: () => {} },
    process: { run: async (argv: string[]) => {
      calls.push(argv);
      const sync = argv[2] === 'sync';
      const receipt = sync && edited ? { kind: 'committed', revision: 2, chars: text.length, approxTokens: 10, text: 'Committed.' } : undefined;
      if (sync) edited = false;
      return { exitCode: 0, stderr: '', stdout: JSON.stringify({ ok: true, ...snapshot,
        revisionKind: sync ? 'model-edit' : 'runner-append', receipt,
        workingContext: '/proj/.context-engine/S1/context.md', frameKey: '00112233445566778899aabbccddeeff',
        budget: { approxTokens: 20_000 }, delivery: prepareWorkingContextDelivery(snapshot, { hardLimit: 600_000, maxBytes: adapter.WITHIN_TURN_MAX_BYTES,
          budgetTokens: argv.includes('--budget') ? Number(argv[argv.indexOf('--budget') + 1]) : undefined }),
      }) };
    } },
  };
  return {
    start: () => handlers.get('session.start')!(host, {}, async () => ({})),
    compact: () => handlers.get('session.compact')!(host, { trigger: 'manual', messages: [] }, async () => ({})),
    tool: (event: Event, result: Result) => handlers.get('tool.call')!(host, event, async () => result),
    setTokens: (tokens: number) => { currentTokens = tokens; }, calls,
  };
}

test('an oversized carrier retains an accepted edit notice for the next ordinary result', async () => {
  const f = fixture();
  await f.start();
  const oversized = { text: 'write succeeded', context: ['x'.repeat(190_001)] };
  assert.deepEqual(await f.tool({ tool: 'Write', file_path: '/proj/.context-engine/S1/context.md' }, oversized), oversized);
  const next = await f.tool({ tool: 'Read', file_path: '/proj/other.txt' }, { text: 'ordinary output' });
  assert.match(next.context?.join('\n') ?? '', /revision 2 was validated/);
  assert.doesNotMatch(next.context?.join('\n') ?? '', /NEW_EDIT_SENTINEL/);
  assert.equal(f.calls.filter(call => call[2] === 'sync').length, 2);
  const third = await f.tool({ tool: 'Read', file_path: '/proj/other.txt' }, { text: 'third output' });
  assert.equal(third.context, undefined);
});

test('mid-turn edit checks retain the baseline until the complete turn is measured', async () => {
  const f = fixture();
  await f.start();
  await f.compact();
  f.setTokens(47_000);
  await f.tool({ tool: 'Write', file_path: '/proj/.context-engine/S1/context.md' }, { text: 'edited' });
  f.setTokens(62_000);
  await f.compact();
  const records = f.calls.filter(call => call[2] === 'record');
  assert.deepEqual(records.map(call => call.at(-1)), ['42000', '25000']);
});

test('read notices accept the core session grammar and reject unsafe identities', () => {
  const text = '[[CTX_TURN 1 role=user]]\nnew content';
  const snapshot = { revision: 2, chars: text.length, workingContextText: text };
  const reply: adapter.CoreReply = { ok: true, ...snapshot, workingContext: '/proj/context.md', revisionKind: 'model-edit',
    receipt: { kind: 'committed', revision: 2, chars: text.length, approxTokens: 10, text: 'Committed.' },
    delivery: prepareWorkingContextDelivery(snapshot, { hardLimit: 600_000, maxBytes: adapter.WITHIN_TURN_MAX_BYTES }),
  };
  assert.match(adapter.withinTurnReadNotice(reply, null, 'session.1', '/checkout/core/cli.ts')!.text, /--session session\.1 /);
  for (const id of ['..', '-flag', 'bad id', 'x'.repeat(129)]) assert.throws(() => adapter.withinTurnReadNotice(reply, null, id, '/checkout/core/cli.ts'));
});

test('a pending notice waits while its current positive budget is too small, then retries', async () => {
  const f = fixture();
  await f.start();
  await f.compact();
  f.setTokens(47_000);
  await f.tool({ tool: 'Write', file_path: '/proj/.context-engine/S1/context.md' }, { context: ['x'.repeat(190_001)] });
  f.setTokens(86_995);
  const tooSmall = await f.tool({ tool: 'Read', file_path: '/proj/other.txt' }, { text: 'small carrier' });
  assert.equal(tooSmall.context, undefined);
  f.setTokens(47_000);
  const ready = await f.tool({ tool: 'Read', file_path: '/proj/other.txt' }, { text: 'safe carrier' });
  assert.match(ready.context?.join('\n') ?? '', /revision 2 was validated/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareWorkingContextDelivery } from '../../../core/delivery.ts';
import { coreArgv, withinTurnReadNotice, WITHIN_TURN_MAX_BYTES, type CoreReply } from '../context-engine/hooks/adapter.ts';

const notice = (reply: CoreReply, last: number | null) => withinTurnReadNotice(reply, last, 'S1', '/checkout with spaces/core/cli.ts');

function reply(text = '[[CTX_TURN role=user]]\nNEW_CONTEXT_SENTINEL\n'): CoreReply {
  const snapshot = { revision: 2, chars: text.length, workingContextText: text };
  return { ok: true, ...snapshot, revisionKind: 'model-edit', workingContext: '/project/.context-engine/s/context.md',
    receipt: { kind: 'committed', revision: 2, chars: text.length, approxTokens: Math.ceil(text.length / 4), text: 'Edit committed.' },
    delivery: prepareWorkingContextDelivery(snapshot, { hardLimit: 600_000, maxBytes: WITHIN_TURN_MAX_BYTES }) };
}

test('a newly accepted edit supplies static metadata and a digest-bound read command', () => {
  const source = reply();
  const result = notice(source, null);
  assert.equal(result!.sha256, source.delivery!.sha256);
  assert.match(result!.text, /node '\/checkout with spaces\/core\/cli.ts' read --session S1 --sha [a-f0-9]{64}/);
  assert.doesNotMatch(result!.text, /NEW_CONTEXT_SENTINEL|<working_context/);
  assert.match(result!.text, /This notice does not deliver its content/);
  assert.match(result!.text, /--framed and read every framed part/);
  assert.equal('delivered' in result!, false);
});

test('a notice alone, unchanged sync, runner append and repeated revision never inject context', () => {
  const source = reply();
  assert.equal(notice({ ...source, delivery: undefined }, null), null);
  assert.equal(notice({ ...source, receipt: undefined }, null), null);
  assert.equal(notice({ ...source, revisionKind: 'runner-append' }, null), null);
  assert.equal(notice(source, 2), null);
  assert.equal(notice({ ...source, revisionKind: undefined }, null), null);
});

test('restored and oversized content are not classified as a delivered edit', () => {
  const source = reply();
  assert.equal(notice({ ...source, receipt: { ...source.receipt!, kind: 'restored' } }, null), null);
  assert.equal(notice(reply('large '.repeat(7000)), null), null);
});

test('a truncated or mismatched delivery packet is refused', () => {
  const source = reply();
  const data = source.delivery!;
  if (data.kind !== 'ready') throw new Error('fixture must fit');
  for (const delivery of [
    { ...data, text: data.text.slice(0, -5) },
    { ...data, text: data.text.replace('NEW_CONTEXT_SENTINEL', 'partial') },
    { ...data, revision: 3 },
    { ...data, sha256: 'not-a-digest' },
    { ...data, bytes: 1 },
  ]) assert.throws(() => notice({ ...source, delivery }, null), /invalid bounded/);
});

test('installed core path is canonical and kept as one argv element', () => {
  const at = { sessionId: 'S1', projectRoot: '/project' };
  assert.equal(coreArgv('/cache/plugin', 'open', at, undefined, undefined, '/checkout with spaces/core/cli.ts')[1], '/checkout with spaces/core/cli.ts');
  assert.equal(coreArgv('/checkout/adapters/claude/context-engine', 'open', at, undefined, undefined, 'checkout-relative')[1], '/checkout/core/cli.ts');
  for (const value of ['', 'relative/core/cli.ts', '/a/../core/cli.ts', '/a//core/cli.ts', '/a/core/other.ts', '/a/core/cli.ts\n', null, 12]) {
    assert.throws(() => coreArgv('/cache/plugin', 'open', at, undefined, undefined, value), /coreCli must name/);
  }
});

test('read notices reject unsafe identity and quote a trusted CLI path literally', () => {
  const source = reply();
  for (const id of ['bad id', 'S1;echo bad', '', '../S1']) assert.throws(() => withinTurnReadNotice(source, null, id, '/checkout/core/cli.ts'), /session identity/);
  assert.throws(() => withinTurnReadNotice(source, null, 'S1', '/a/../core/cli.ts'), /coreCli/);
  const result = withinTurnReadNotice(source, null, 'S1', "/checkout's $name/core/cli.ts");
  assert.ok(result!.text.includes("node '/checkout'\\''s $name/core/cli.ts' read"));
});

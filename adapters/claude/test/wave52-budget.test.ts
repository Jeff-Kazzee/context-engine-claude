import test from 'node:test';
import assert from 'node:assert/strict';
import { workingContextBudget } from '../context-engine/hooks/adapter.ts';

test('wave52: large historical observation input becomes one running maximum', () => {
  const observed = Array.from({ length: 200000 }, (_, index) => index === 7 ? 12000 : 1000);
  const result = workingContextBudget({ breakdown: null, envTokens: '100000', turn: { observed } });
  assert.ok(result);
  assert.equal(result.reserveTokens, 12000);
  assert.deepEqual(result.observed, [12000]);
  const later = workingContextBudget({ breakdown: null, envTokens: '100000', turn: { observed: result.observed, contextTokens: 1000, deliveredTokens: 1000 } });
  assert.ok(later);
  assert.deepEqual(later.observed, [12000]);
  assert.equal(later.reserveTokens, 12000);
});

test('wave52: first budget observation retains an observed zero', () => {
  const result = workingContextBudget({ breakdown: null, envTokens: '100000', turn: { observed: [], contextTokens: 1000, deliveredTokens: 1000 } });
  assert.ok(result);
  assert.deepEqual(result.observed, [0]);
});

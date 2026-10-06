// Context Engine for Claude Code, V1 (default). Delivery mode: Full Replacement per user turn;
// Injection within a turn.
//
// - session.start opens the session in the shared core (lock, crash recovery).
// - prompt.compose adds one static, session-scoped section: where the Working Context file is, and
//   that it is data at user-message authority. The file's contents never enter the system prompt.
// - session.compact (manual, plugin or auto; main conversation only) mirrors every message since the
//   last Working Context frame into the core in one batch (`record`, which commits any edit the
//   agent made first), then answers with the committed file as ONE user-role message. `next` is not
//   called, so no summarizer request is made. Rows are recorded only here, so the current turn is
//   not in the Event Log (and not recallable) until the next compaction. The compaction at each
//   user-turn boundary is raised by the separate context-engine-trigger plugin (a plugin's own call
//   skips its own hook as re-entry); headless hosts send `/compact` between turns instead.
// - Budget (issues #22, #23): each compaction passes the core the Working Context's budget (Claude
//   Code's auto-compact threshold, or CONTEXT_ENGINE_BUDGET_TOKENS, minus the Pinned Prefix, from
//   `$.session.usage`, minus a turn reserve measured from this session's turns; see
//   workingContextBudget), and the frame carries the core's size readout and reminders. When the
//   Working Context is over that budget, delivering it would leave the turn no room under Claude
//   Code's threshold (the smoke and pilot runs' "Autocompact is thrashing"), so that compaction falls back to Claude Code's
//   own summarizer (`next`), its result becomes the next Revision (core `native-compaction`), and the
//   frame, the transcript log, the Event Log and the status line label it Compaction-only.
// - tool.call + session.append stub the echo of the agent's own Read of the file, which would
//   otherwise repeat the whole Working Context inside the turn.
// - Participation: every core call passes --if-enabled. In a project nobody enabled (the pilot is
//   opt-in), or with the kill switch CONTEXT_ENGINE=off, the core does nothing and the mod stands
//   aside for the session: no section, native compaction, the trigger's compaction skipped.
// - One writer per session: when another live process holds the session (at open or at record),
//   the trigger's per-turn compaction is skipped; any other compaction runs natively, so the
//   context cannot overflow.
// - Fail safe: when the core fails, Claude Code compacts natively and the error is logged.
//
// Experimental per-step mode (opt-in: CONTEXT_ENGINE_CLAUDE_MODE=per-step, or the plugin option
// `mode: per-step`): the `turn.step` hook below. Its logic is the pure functions of per-step.ts;
// only the `$` plumbing is here, because the engine follows `$` only into functions of the hooks
// module's own file.
//
// The core is reached only through `$.process.run(['node', <checkout>/core/cli.ts, ...])`.
import type { EngineInterface, Register, TurnStepInput } from 'claude-code';
import {
  type ApiMessage,
  type CoreCommand,
  type CoreReply,
  COMPACTION_ONLY_FALLBACK,
  type ContextBreakdown,
  CoreError,
  FrameBoundaryError,
  HARD_LIMIT_CHARS,
  FALLBACK_STATUS,
  compactionText,
  fallbackNotice,
  fallbackNotRecorded,
  noRoomNotice,
  type WorkingContextBudget,
  nativeEvents,
  type NativeMessage,
  workingContextBudget,
  coreArgv,
  eventsSinceLastFrame,
  hasShellTail,
  assertShellBoundary,
  isWorkingContextPath,
  parseCoreReply,
  staleRefsOn,
  stubWorkingContextReads,
  systemSectionText,
  checkLegacyFrame,
  hasOnlyUnkeyedFrames,
} from './adapter.ts';
import {
  type ApiResponse,
  MESSAGES_API,
  PER_STEP_STATUS,
  type StepRequest,
  buildStepRequest,
  parseStepResponse,
  perStepOn,
  requestLogPath,
  requestLogRecord,
  stepChunks,
  stepFailure,
  stepFetchInit,
} from './per-step.ts';

const SECTION_ID = 'context-engine:working-context';

function committedText(reply: CoreReply): string {
  if (typeof reply.workingContextText !== 'string') throw new Error('core reply has no committed Working Context snapshot; delivery refused');
  return reply.workingContextText;
}

type Opened = { sessionId: string; projectRoot: string; workingContext: string; frameKey: string };

/** Set once the core has opened this session; null when the mod stands aside. */
let opened: Opened | null = null;
/** A discarded session whose close failed; retained for session-end retry. */
let abandoned: Opened | null = null;
let opening: Promise<Opened | null> | null = null;
/** Serializes this process's core calls (the core also serializes calls per session). */
let queue: Promise<unknown> = Promise.resolve();
/** Reads of the file whose echo is stubbed, and whether the agent changed the file this turn. */
const stubIds = new Set<string>();
let editedThisTurn = false;
/** The plugin's `mode` option, as `register` received it. */
let modeOption: unknown;
/** Whether this session runs the experimental per-step mode; decided once per session, on first use. */
let perStep: boolean | null = null;
/** The core's state directory for this session (per-step request log), read once. */
let stateDir: string | null = null;
/** Whether the last compaction fell back to Claude Code's summarizer (the status line says so until the next). */
let fellBack = false;
/**
 * The turn reserve's inputs (issue #23): the Working Context delivered at the last compaction (its
 * readout, tokens) and the turn inputs observed this session. Kept by this process only, so a
 * resumed session starts again from the floor.
 */
let delivered: number | undefined;
let lastDeliveredRevision: number | undefined;
let executingTools = 0;
let boundaryGate: Promise<void> | null = null;
let turnInputs: readonly number[] = [];

/** An ambiguous resume (unkeyed frames only) was refused (adapter.ts checkLegacyFrame); `message` is the receipt. */
class LegacyUpgradeRefused extends Error {}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function log($: EngineInterface, text: string, to: 'transcript' | 'debug' = 'transcript'): void {
  $.ui.log(text.startsWith('Context Engine') ? text : `Context Engine: ${text}`, { to });
}

function core($: EngineInterface, at: Opened, command: CoreCommand, stdin?: string, budgetTokens?: number): Promise<CoreReply> {
  const call = queue.then(async () =>
    parseCoreReply(await $.process.run(coreArgv($.plugin.root, command, at, budgetTokens), { cwd: at.projectRoot, stdin, timeoutMs: 60_000 })),
  );
  queue = call.catch(() => undefined);
  return call;
}

async function openCore($: EngineInterface): Promise<Opened | null> {
  const at = { sessionId: await $.session.id(), projectRoot: await $.session.root(), workingContext: '', frameKey: '' };
  try {
    const reply = await core($, at, 'open');
    // Without the session's frame key the mod could not tell its own frames from look-alikes.
    if (!reply.frameKey) throw new CoreError('the core gave no frame key (core older than this mod?)');
    opened = { ...at, workingContext: reply.workingContext, frameKey: reply.frameKey };
    if (reply.receipt) log($, reply.receipt.text);
    log($, `session open at revision ${reply.revision}; Working Context ${reply.workingContext}`, 'debug');
  } catch (err) {
    opened = null;
    // Not enabled for this project, or the kill switch: the normal case outside the pilot, so it
    // stays off screen. Anything else is a fault worth showing.
    const quiet = err instanceof CoreError && err.inactive;
    log($, `inactive for this session, so Claude Code's own behaviour applies (${message(err)})`, quiet ? 'debug' : 'transcript');
  }
  return opened;
}

function ensureOpen($: EngineInterface): Promise<Opened | null> {
  opening ??= openCore($);
  return opening;
}

async function perStepMode($: EngineInterface): Promise<boolean> {
  if (perStep === null) {
    perStep = perStepOn(await $.env.get('CONTEXT_ENGINE_CLAUDE_MODE'), modeOption);
    if (perStep) {
      $.ui.status(PER_STEP_STATUS);
      log($, PER_STEP_STATUS);
    }
  }
  return perStep;
}

async function section($: EngineInterface, at: Opened) {
  const staleRefs = staleRefsOn(await $.env.get('CONTEXT_ENGINE_EXPERIMENTS'));
  const text = systemSectionText(at.workingContext, { sessionId: at.sessionId, staleRefs, perStep: await perStepMode($) });
  return { id: SECTION_ID, scope: 'session' as const, text };
}

/**
 * The Working Context's budget now, or null when there is nothing to go on (`exhausted` when no
 * room is left at all). Folds the turn that just ended (Claude Code's last request, on top of the
 * Working Context delivered before it) into the turn reserve.
 */
async function budgetNow($: EngineInterface): Promise<WorkingContextBudget | null> {
  // Never lets a missing figure break a compaction: no figures, no budget.
  const quietly = <T>(what: string, f: () => Promise<T>): Promise<T | undefined> =>
    f().catch((err) => {
      log($, `no ${what} for the budget: ${message(err)}`, 'debug');
      return undefined;
    });
  const context = await quietly('context breakdown', async () => (await $.session.usage({ breakdown: 'summary' })).context);
  const breakdown = context?.breakdown as ContextBreakdown | undefined;
  const envTokens = (await quietly('CONTEXT_ENGINE_BUDGET_TOKENS', () => $.env.get('CONTEXT_ENGINE_BUDGET_TOKENS'))) ?? undefined;
  const b = workingContextBudget({ breakdown: breakdown ?? null, envTokens, turn: { contextTokens: context?.tokens, deliveredTokens: delivered, observed: turnInputs } });
  delivered = undefined;
  if (b) {
    turnInputs = b.observed;
    log($, `Working Context budget ${b.budgetTokens} tokens${b.exhausted ? ' (no room: Compaction-only fallback)' : ''} (${b.source} ${b.sharedTokens} minus Pinned Prefix ${b.pinnedTokens} minus turn reserve ${b.reserveTokens}; turns observed ${b.observed.length})`, 'debug');
  }
  return b;
}

// ---- per-step mode: the `$` plumbing around per-step.ts ----

/**
 * Refuses an ambiguous resume (adapter.ts checkLegacyFrame): throws LegacyUpgradeRefused when the
 * conversation holds an unkeyed frame, no keyed one, and the session has a committed Working
 * Context. No unkeyed frame is ever a boundary. The core is asked for its revision only when an
 * unkeyed frame is present and no keyed one.
 */
async function refuseAmbiguousResume($: EngineInterface, at: Opened, messages: readonly ApiMessage[]): Promise<void> {
  if (!hasOnlyUnkeyedFrames(messages, at.frameKey)) return;
  const status = await core($, at, 'status');
  const check = checkLegacyFrame(messages, at.frameKey, status.revision);
  if (check.kind === 'refused') throw new LegacyUpgradeRefused(check.text);
}

/** Closes a discarded session, retaining a failed close for session-end retry. */
async function abandonCore($: EngineInterface): Promise<void> {
  const at = opened ?? abandoned;
  opened = null;
  opening = Promise.resolve(null);
  if (perStep || fellBack) $.ui.status(undefined);
  fellBack = false;
  if (!at) return;
  abandoned = at;
  try {
    await core($, at, 'close');
    if (abandoned === at) abandoned = null;
  } catch (err) {
    log($, `close failed; handle retained for cleanup: ${message(err)}`, 'debug');
  }
}

/** Stands aside for the rest of the session after a refused boundary. */
async function standAsideForUpgrade($: EngineInterface, err: LegacyUpgradeRefused | FrameBoundaryError): Promise<void> {
  await abandonCore($);
  if (perStep || fellBack) $.ui.status(undefined);
  fellBack = false;
  log($, err.message);
}

/** Prevent new root tools from mutating context while a replacement is observed and delivered. */
async function acquireBoundary(at: Opened): Promise<() => void> {
  while (boundaryGate) await boundaryGate;
  assertNoActiveTools();
  if (opened !== at) throw new FrameBoundaryError('Context Engine: session changed during replacement; records nothing.');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  boundaryGate = gate;
  return () => { if (boundaryGate === gate) boundaryGate = null; release(); };
}

function assertNoActiveTools(): void {
  if (executingTools > 0) throw new FrameBoundaryError('Context Engine: a tool is still running; records nothing and leaves this session to Claude Code.');
}

async function observeBoundary($: EngineInterface, at: Opened, messages: ApiMessage[], budget?: number): Promise<CoreReply> {
  assertNoActiveTools();
  let reply: CoreReply;
  try { reply = await core($, at, 'sync', undefined, budget); }
  catch (err) {
    if (hasShellTail(messages, at.frameKey)) throw new FrameBoundaryError(`Context Engine: cannot verify the Working Context after Bash; records nothing (${message(err)}).`);
    throw err;
  }
  assertNoActiveTools();
  assertShellBoundary(messages, at.frameKey, reply.revision, lastDeliveredRevision, reply.receipt?.kind === 'restored');
  return reply;
}

/** Builds this step's request: syncs the core first, so the file sent is the committed revision. */
async function buildStep($: EngineInterface, at: Opened, e: TurnStepInput): Promise<{ body: StepRequest; revision: number; deliveredTokens: number }> {
  assertNoActiveTools();
  const messages = (await $.session.messages({ as: 'api' })) as ApiMessage[];
  const room = await budgetNow($);
  const budget = room && !room.exhausted ? room.budgetTokens : undefined;
  const reply = await observeBoundary($, at, messages, budget);
  if (room?.exhausted || reply.budget?.overBudget || reply.chars > HARD_LIMIT_CHARS) {
    throw new Error('Working Context exceeds the per-step budget or hard limit');
  }
  if (reply.receipt) log($, reply.receipt.text);
  const [fileText, composed, tools, own] = await Promise.all([
    // Before the first commit (revision 0) there is no file yet; after it, a sync leaves one in place.
    Promise.resolve(committedText(reply)),
    $.prompt.compose(),
    $.tool.list(),
    section($, at),
  ]);
  // Check the committed text too before delivering this step.
  if (String(fileText).length > HARD_LIMIT_CHARS || (budget !== undefined && Math.ceil(String(fileText).length / 4) > budget)) {
    throw new Error('Working Context exceeds the per-step budget or hard limit');
  }
  await refuseAmbiguousResume($, at, messages as ApiMessage[]);
  assertNoActiveTools();
  const body = buildStepRequest({
    model: e.model,
    messages: messages as ApiMessage[],
    wcPath: reply.workingContext,
    frameKey: at.frameKey,
    fileText: String(fileText),
    notices: reply.receipt ? [reply.receipt.text] : [],
    sections: composed.sections,
    ownSection: own,
    tools,
  });
  return { body, revision: reply.revision, deliveredTokens: Math.ceil(String(fileText).length / 4) };
}

/** Sends the step on the session's own auth handle (Claude Code resolves it; the mod never sees a credential). */
async function sendStep($: EngineInterface, auth: { handle: string; kind: string }, body: StepRequest): Promise<{ status: number; response: ApiResponse }> {
  try {
    const res = await $.http.fetch(MESSAGES_API, stepFetchInit(auth, body));
    return { status: res.status, response: parseStepResponse(res.text) };
  } catch (err) {
    return { status: 0, response: { error: message(err) } };
  }
}

/** Writes one request record under the core's state directory; a failure here never fails the step. */
async function logRequest($: EngineInterface, at: Opened, e: TurnStepInput, r: { revision: number; status: number; ms: number; body: StepRequest; response: ApiResponse }) {
  try {
    stateDir ??= ((await core($, at, 'status')) as CoreReply & { stateDir: string }).stateDir;
    const record = requestLogRecord({ at: new Date().toISOString(), sessionId: at.sessionId, turnId: e.turnId, index: e.index, ...r });
    await $.fs.write(requestLogPath(stateDir, Date.now(), e.turnId, e.index), `${JSON.stringify(record)}\n`);
  } catch (err) {
    log($, `per-step request log not written: ${message(err)}`, 'debug');
  }
}

export const register: Register = (on, options) => {
  modeOption = options.mode;

  on('session.start', async ($, e, next) => {
    opening = null;
    opened = null;
    perStep = null;
    stateDir = null;
    fellBack = false;
    delivered = undefined;
    lastDeliveredRevision = undefined;
    executingTools = 0;
    turnInputs = [];
    await ensureOpen($);
    return next(e);
  });

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e);
    const at = await ensureOpen($);
    if (!at) return r;
    const own = await section($, at);
    return { sections: [...r.sections.filter((s) => s.id !== SECTION_ID), own] };
  });

  on('turn.step', async function* ($, e, next) {
    const at = opened;
    if (e.agentId || !at || !(await perStepMode($))) return yield* next(e);
    let releaseBoundary: (() => void) | undefined;
    const releaseLease = () => { releaseBoundary?.(); releaseBoundary = undefined; };
    try {
      try { releaseBoundary = await acquireBoundary(at); }
      catch (err) { await standAsideForUpgrade($, err as FrameBoundaryError); releaseLease(); return yield* next(e); }
      let built: { body: StepRequest; revision: number; deliveredTokens: number };
      try {
        built = await buildStep($, at, e);
      } catch (err) {
        if (err instanceof LegacyUpgradeRefused || err instanceof FrameBoundaryError) await standAsideForUpgrade($, err);
        else {
          if (err instanceof CoreError && err.inactive) await abandonCore($);
          log($, `per-step request not built, so Claude Code sends this step itself: ${message(err)}`);
        }
        releaseLease(); return yield* next(e);
      }
      try { assertNoActiveTools(); } catch (err) {
        await standAsideForUpgrade($, err as FrameBoundaryError);
        releaseLease(); return yield* next(e);
      }
      let auth: Awaited<ReturnType<typeof $.session.authorize>>;
      try { auth = await $.session.authorize(); }
      catch (err) {
        log($, `session authorization failed, so Claude Code sends this step itself: ${message(err)}`);
        releaseLease(); return yield* next(e);
      }
      if (!auth) {
        log($, 'per-step mode needs the session credential handle and there is none, so Claude Code sends this step itself');
        releaseLease(); return yield* next(e);
      }
      const started = Date.now();
      const { status, response } = await sendStep($, auth, built.body);
      await logRequest($, at, e, { revision: built.revision, status, ms: Date.now() - started, body: built.body, response });
      const failure = stepFailure(status, response);
      if (failure) {
        log($, `per-step request failed (${failure}), so Claude Code sends this step itself`);
        releaseLease(); return yield* next(e);
      }
      delivered = built.deliveredTokens;
      lastDeliveredRevision = built.revision;
      const { chunks, result } = stepChunks(response, e);
      for (const c of chunks) yield c;
      return result;
    } finally { releaseLease(); }
  });

  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId) return next(e);
    const at = await ensureOpen($);
    if (!at) {
      // The trigger plugin's per-turn compaction exists only to deliver the Working Context.
      if (e.trigger === 'plugin') return { skip: 'Context Engine is inactive for this session' };
      return next(e);
    }
    let releaseBoundary: (() => void) | undefined;
    const releaseLease = () => { releaseBoundary?.(); releaseBoundary = undefined; };
    let uncertainTail = false;
    let nativeRan = false;
    let nativeResult: Awaited<ReturnType<typeof next>> | undefined;
    try {
      releaseBoundary = await acquireBoundary(at);
      assertNoActiveTools();
      const room = await budgetNow($);
      // The core takes only a positive budget; no room at all is the fallback below, never "no budget".
      const budget = room && !room.exhausted ? room.budgetTokens : undefined;
      const messages = (await $.session.messages({ as: 'api' })) as ApiMessage[];
      await refuseAmbiguousResume($, at, messages);
      // This observation reply is discarded; only the delivered record may consume reminder tiers.
      if (hasShellTail(messages, at.frameKey)) await observeBoundary($, at, messages);
      assertNoActiveTools();
      const events = eventsSinceLastFrame(messages, at.workingContext, at.frameKey);
      uncertainTail = events.length > 0; // A lost response may follow a durable append/commit.
      const reply = await core($, at, 'record', JSON.stringify(events), budget);
      uncertainTail = true;
      if (reply.receipt) log($, reply.receipt.text);
      stubIds.clear();
      editedThisTurn = false;
      if (room?.exhausted || reply.budget?.overBudget || reply.chars > HARD_LIMIT_CHARS) {
        // Fallback: Claude Code's own summarizer compacts; its result becomes the next Revision.
        nativeRan = true;
        fellBack = true;
        $.ui.status(FALLBACK_STATUS);
        releaseLease();
        const native = await next(e);
        nativeResult = native;
        releaseBoundary = await acquireBoundary(at);
        if (!native.messages) { await abandonCore($); return native; }
        let replaced: CoreReply;
        try {
          replaced = await core($, at, 'native-compaction', JSON.stringify(nativeEvents(native.messages as readonly NativeMessage[])), budget);
        } catch (err) {
          // Fail safe: Claude Code's summary is the compaction either way, so it is returned as it
          // is; only its Revision is missing (the Working Context file still holds the old text).
          await abandonCore($);
          log($, fallbackNotRecorded(message(err)));
          return native;
        }
        if (replaced.chars > HARD_LIMIT_CHARS) { await abandonCore($); return native; }
        const notice = reply.chars > HARD_LIMIT_CHARS
          ? `Context Engine: ${COMPACTION_ONLY_FALLBACK.label} for this compaction. The Working Context exceeded the runner hard limit (${HARD_LIMIT_CHARS} characters); Claude Code compacted it natively.`
          : reply.budget?.overBudget
          ? fallbackNotice({ approxTokensBefore: reply.budget.approxTokens, budgetTokens: reply.budget.budgetTokens, revision: replaced.revision })
          : noRoomNotice({ ...room!, revision: replaced.revision });
        const fileText = committedText(replaced);
        assertNoActiveTools();
        delivered = replaced.budget?.approxTokens;
        lastDeliveredRevision = replaced.revision;
        log($, notice);
        const notices = [notice, ...(replaced.budget ? [replaced.budget.text] : [])];
        return { messages: [{ role: 'user', text: compactionText(replaced.workingContext, fileText, notices, COMPACTION_ONLY_FALLBACK.label, at.frameKey), toolUses: [] }] };
      }
      const fileText = committedText(reply);
      const notices = [...(reply.receipt ? [reply.receipt.text] : []), ...(reply.budget ? [reply.budget.text] : [])];
      assertNoActiveTools();
      delivered = reply.budget?.approxTokens;
      lastDeliveredRevision = reply.revision;
      if (fellBack) {
        fellBack = false;
        $.ui.status(perStep ? PER_STEP_STATUS : undefined);
      }
      log($, `${e.trigger} compaction answered from revision ${reply.revision} (${reply.chars} chars, ${events.length} new turns)`, 'debug');
      return { messages: [{ role: 'user', text: compactionText(reply.workingContext, fileText, notices, undefined, at.frameKey), toolUses: [] }] };
    } catch (err) {
      if (uncertainTail) {
        await abandonCore($);
        log($, `recording outcome or delivery uncertain; standing aside to prevent replay (${message(err)})`);
        if (nativeRan) { if (nativeResult) return nativeResult; throw err; }
        if (e.trigger === 'plugin') return { skip: 'Context Engine: recording outcome or delivery uncertain; session inactive' };
        releaseLease(); return next(e);
      }
      if (err instanceof LegacyUpgradeRefused || err instanceof FrameBoundaryError) {
        // Nothing was recorded and the mod stays out of this session. Ambiguous
        // keyed replays skip scheduled compaction; legacy upgrade keeps its native fallback.
        await standAsideForUpgrade($, err);
        if (nativeRan) { if (nativeResult) return nativeResult; throw err; }
        if (e.trigger === 'plugin' && err instanceof FrameBoundaryError) return { skip: 'Context Engine: ambiguous frame; compaction skipped' };
        releaseLease(); return next(e);
      }
      if (nativeRan) {
        // Never run Claude Code's compaction twice. If it returned, its result stands (the Revision was
        // recorded, but the frame could not be built); if it failed by itself, so does this.
        log($, `the Compaction-only fallback frame was not built: ${message(err)}`);
        if (nativeResult) return nativeResult;
        throw err;
      }
      if (err instanceof CoreError && err.inactive) {
        // Disabled mid-session, or the kill switch: stand aside for the rest of the session.
        await abandonCore($);
        if (perStep || fellBack) $.ui.status(undefined);
        fellBack = false;
        log($, `inactive from now on (${message(err)})`, 'debug');
        if (e.trigger === 'plugin') return { skip: 'Context Engine is inactive for this session' };
        releaseLease(); return next(e);
      }
      if (err instanceof CoreError && err.refused) {
        // Another live process holds the session. The per-turn compaction exists only to deliver
        // the Working Context, so it is skipped rather than summarized; any other compaction runs
        // natively, so the context cannot overflow.
        log($, `${message(err)}; ${e.trigger === 'plugin' ? 'per-turn compaction skipped' : 'compaction left to Claude Code'}`);
        if (e.trigger === 'plugin') return { skip: 'Context Engine: the session is held by another process' };
        releaseLease(); return next(e);
      }
      if (e.trigger === 'plugin') {
        log($, `per-turn compaction skipped: ${message(err)}`);
        return { skip: 'Context Engine: core unavailable; compaction skipped' };
      }
      log($, `compaction left to Claude Code: ${message(err)}`);
      releaseLease(); return next(e);
    } finally { releaseLease(); }
  });

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) while (boundaryGate) await boundaryGate;
    const tracked = !!opened && !e.agentId;
    if (tracked) executingTools++;
    try {
      // Shell input has no trustworthy file_path. Preserve later reads rather
      // than trying to infer filesystem effects from arbitrary shell syntax.
      if (opened && !e.agentId && String(e.tool) === 'Bash') {
        editedThisTurn = true;
        stubIds.clear();
      }
      if (opened && !e.agentId && isWorkingContextPath((e as { file_path?: unknown }).file_path, opened.workingContext)) {
        if (String(e.tool) !== 'Read') editedThisTurn = true;
        else if (!editedThisTurn && e.tool_use_id) stubIds.add(e.tool_use_id);
      }
      return await next(e);
    } finally { if (tracked) executingTools--; }
  });

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    if (e.agentId || stubIds.size === 0) return next(e);
    const content = stubWorkingContextReads(e.message.content, stubIds);
    if (!content) return next(e);
    log($, 'stubbed the echo of a Working Context Read', 'debug');
    return next({ ...e, message: { ...e.message, content } });
  });

  on('session.end', async ($, e, next) => {
    await abandonCore($);
    opening = null;
    if (perStep || fellBack) $.ui.status(undefined);
    fellBack = false;
    return next(e);
  });
};

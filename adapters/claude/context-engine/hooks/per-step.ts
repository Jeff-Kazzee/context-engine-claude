// Claude Code Adapter, experimental per-step mode (V2): pure functions, no Node.
//
// A `turn.step` hook builds each model request itself instead of letting Claude Code send its own:
// the system prompt as `$.prompt.compose()` gives it, tool schemas, then ONE user message that opens
// with the Working Context (the committed revision, read at this step) followed by the current
// turn's own rows (its tail). The tail is everything after the last Working Context frame in Claude
// Code's conversation; with the turn-boundary compaction (V1) running, that is the current turn.
// Nothing before the frame is ever sent, so deleted text cannot come back from Claude Code's
// transcript.
import { type ApiMessage, type Block, PER_STEP_LABEL, compactionText, isFrame, isWorkingContextPath, splitAtLastFrame, toolResultText, toolUseText } from './adapter.ts';

export { PER_STEP_LABEL, PER_STEP_MODE, PER_STEP_STATUS } from './adapter.ts';

export type Section = { id: string; text: string; scope: 'shared' | 'session' };
export type ToolDescription = { name: string; description: string };
export type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
export type ToolSchema = { name: string; description: string; input_schema: Record<string, unknown> };

export type StepRequest = {
  model: string;
  max_tokens: number;
  system: SystemBlock[];
  tools: ToolSchema[];
  messages: ApiMessage[];
  stream: false;
};

export type StepInput = {
  /** The model the step names (`turn.step`'s `e.model`). */
  model: string;
  /** Claude Code's conversation as `$.session.messages({ as: 'api' })` gives it. */
  messages: readonly ApiMessage[];
  wcPath: string;
  /** The session's frame key (core `open`): marks this Adapter's own frames (isFrame). */
  frameKey: string;
  /** The Working Context as committed (read after a core sync at this step). */
  fileText: string;
  /** Core receipts to show the model inside the frame. */
  notices?: readonly string[];
  /** `$.prompt.compose()`'s sections. */
  sections: readonly Section[];
  /** This mod's own section, added when the compose call did not carry it. */
  ownSection: Section;
  /** `$.tool.list()`: the tools the model can call now, names and descriptions. */
  tools: readonly ToolDescription[];
  maxTokens?: number;
};

export const DEFAULT_MAX_TOKENS = 16_384;

/** The step's messages: Claude Code's context reminders, the Working Context frame, then the tail. */
function stepMessages(input: StepInput): ApiMessage[] {
  const frame: Block = { type: 'text', text: compactionText(input.wcPath, input.fileText, input.notices ?? [], PER_STEP_LABEL, input.frameKey) };
  const { lead, tail } = leadAndTail(input.messages, input.frameKey);
  return paired([{ role: 'user', content: [...lead, frame] }, ...stubWorkingContextTraffic(tail, input.wcPath)]);
}

/** Consecutive messages of one role become one; empty messages go. */
function merged(messages: readonly ApiMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (const m of messages) {
    if (m.content.length === 0) continue;
    const last = out.at(-1);
    if (last && last.role === m.role) last.content.push(...m.content);
    else out.push({ role: m.role, content: [...m.content] });
  }
  return out;
}

function asText(b: Block): Block {
  return { type: 'text', text: b.type === 'tool_use' ? toolUseText(b) : toolResultText(b) };
}

/**
 * The Messages API's pairing rule, kept: each tool_use is answered by a tool_result in the very next
 * (user) message, and that message opens with its results. A tool_use with no answer there, or a
 * tool_result whose call is not in the message just before it, is turned into plain text.
 */
function paired(messages: readonly ApiMessage[]): ApiMessage[] {
  const ms = merged(messages);
  const ids = (m: ApiMessage | undefined, type: string, key: string) => new Set(m ? m.content.filter((b) => b.type === type).map((b) => String(b[key])) : []);
  return ms.map((m, i) => {
    if (m.role === 'assistant') {
      const answered = ms[i + 1]?.role === 'user' ? ids(ms[i + 1], 'tool_result', 'tool_use_id') : new Set<string>();
      return { role: m.role, content: m.content.map((b) => (b.type === 'tool_use' && !answered.has(String(b.id)) ? asText(b) : b)) };
    }
    const prev = ms[i - 1];
    const asked = prev?.role === 'assistant' ? ids(prev, 'tool_use', 'id') : new Set<string>();
    const content = m.content.map((b) => (b.type === 'tool_result' && !asked.has(String(b.tool_use_id)) ? asText(b) : b));
    return { role: m.role, content: [...content.filter((b) => b.type === 'tool_result'), ...content.filter((b) => b.type !== 'tool_result')] };
  });
}

export const WC_INPUT_NOTE = 'input elided; the current file is the <working_context> message';
const WC_READ = '(Read of the Working Context file: its current text is the <working_context> message above. Line numbers are not shown; use exact text from that message for Edit.)';
const WC_APPLIED = '(Working Context edit applied. The <working_context> message above already shows the file with this edit; do not redo it.)';
const WC_FAILED = '(Working Context file operation failed. The file as it stands now is the <working_context> message above; use exact text from it.)';

/**
 * In the request only (Claude Code's transcript keeps its rows): tool calls on the Working Context
 * file and their results are stubbed, so the old text does not ride along in an Edit's `old_string`,
 * a Write's `content`, a Read's echo or an error's echo. A Read's input holds no file text and is
 * kept. Thinking is dropped (the request asks for none, and its signatures belong to Claude Code's
 * own requests).
 */
function stubWorkingContextTraffic(tail: readonly ApiMessage[], wcPath: string): ApiMessage[] {
  const onWc = new Map<string, string>();
  return tail.map((m) => ({
    role: m.role,
    content: m.content
      .filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
      .map((b): Block => {
        if (b.type === 'tool_use' && isWorkingContextPath((b.input as { file_path?: unknown } | undefined)?.file_path, wcPath)) {
          onWc.set(String(b.id), String(b.name));
          return b.name === 'Read' ? b : { type: 'tool_use', id: b.id, name: b.name, input: { file_path: wcPath, note: WC_INPUT_NOTE } };
        }
        const tool = b.type === 'tool_result' ? onWc.get(String(b.tool_use_id)) : undefined;
        if (tool !== undefined) {
          if (b.is_error) return { type: 'tool_result', tool_use_id: b.tool_use_id, content: WC_FAILED, is_error: true };
          return { type: 'tool_result', tool_use_id: b.tool_use_id, content: tool === 'Read' ? WC_READ : WC_APPLIED };
        }
        return b;
      }),
  }));
}

const isReminder =(b: Block): boolean => b.type === 'text' && String(b.text ?? '').trimStart().startsWith('<system-reminder>');

/**
 * The conversation split at the last Working Context frame (splitAtLastFrame): `lead` is the context
 * reminders Claude Code put ahead of the frame in the same message (environment, CLAUDE.md, date),
 * `tail` every block after it. With no frame yet the whole conversation is the tail, and its first
 * message's leading reminders are the lead.
 */
function leadAndTail(messages: readonly ApiMessage[], frameKey: string): { lead: Block[]; tail: ApiMessage[] } {
  const { before, tail } = splitAtLastFrame(messages, frameKey);
  if (before !== null) return { lead: before.filter(isReminder), tail };
  const [first, ...rest] = tail;
  if (!first || first.role !== 'user') return { lead: [], tail };
  const n = first.content.findIndex((b) => !isReminder(b));
  const cut = n < 0 ? first.content.length : n;
  return { lead: first.content.slice(0, cut), tail: [{ role: 'user', content: first.content.slice(cut) }, ...rest] };
}

/** Adapter-authored identity; it is not the runner's identity sentence. */
export const IDENTITY = "You are a coding agent using Context Engine inside Claude Code.";
const EPHEMERAL = { type: 'ephemeral' } as const;

/** Identity line, the shared sections joined, the session sections joined (this mod's once). */
function systemBlocks(sections: readonly Section[], own: Section): SystemBlock[] {
  const all = [...sections.filter((s) => s.id !== own.id), own];
  const shared = all.filter((s) => s.scope === 'shared').map((s) => s.text).join('\n\n');
  const session = all.filter((s) => s.scope === 'session').map((s) => s.text).join('\n\n');
  const blocks: SystemBlock[] = [IDENTITY, shared, session].filter((t) => t !== '').map((text) => ({ type: 'text', text }));
  blocks[blocks.length - 1] = { ...blocks.at(-1)!, cache_control: EPHEMERAL };
  return blocks;
}

const str = (description: string) => ({ description, type: 'string' });
const int = (description: string, min: Record<string, number>) => ({ description, type: 'integer', ...min, maximum: Number.MAX_SAFE_INTEGER });
const num = (description: string) => ({ description, type: 'number' });
const bool = (description: string, dflt?: boolean) => ({ description, ...(dflt === undefined ? {} : { default: dflt }), type: 'boolean' });
const object = (properties: Record<string, unknown>, required: string[]) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/**
 * Compatibility schemas authored here from the observed input contract of Claude Code 2.1.289.
 * Property names, types and bounds describe its interface; all description prose is ours.
 * No captured schema text is shipped. These are not wire-identical runner schemas, and the
 * reworded descriptions have not been checked with a real per-step model request.
 */
export const KNOWN_SCHEMAS: Record<string, Record<string, unknown>> = {
  Edit: object({
    file_path: str('Choose the target file using its absolute filesystem location.'),
    old_string: str('Supply the existing span that this edit should find.'),
    new_string: str('Supply replacement text that differs from the matched span.'),
    replace_all: bool('Apply the substitution to every match when enabled; otherwise use one match.', false),
  }, ['file_path', 'old_string', 'new_string']),
  Read: object({
    file_path: str('Choose the source file using its absolute filesystem location.'),
    offset: int('Optional starting line for a partial read; omit for the normal read.', { minimum: 0 }),
    limit: int('Optional positive line count for a partial read.', { exclusiveMinimum: 0 }),
    pages: str('For a PDF, select page numbers or an inclusive interval, with at most twenty pages.'),
  }, ['file_path']),
  Write: object({
    file_path: str('Choose the destination using an absolute filesystem location.'),
    content: str('Provide the complete text to place in the destination file.'),
  }, ['file_path', 'content']),
  Bash: object({
    command: str('Provide the shell program text to run.'),
    timeout: num('Optional execution deadline in milliseconds; foreground maximum is 600000.'),
    description: str('Describe the purpose of this shell action briefly for the user.'),
    run_in_background: bool('Request background execution. Its deadline defaults to 1800000 ms and cannot exceed 7200000 ms.'),
    dangerouslyDisableSandbox: bool('Request execution outside the sandbox only through the normal runner approval controls.'),
  }, ['command']),
};

/** A tool with no known schema is offered with its live description and an open object schema. */
const OPEN_SCHEMA = { type: 'object', additionalProperties: true };

function toolSchemas(tools: readonly ToolDescription[]): ToolSchema[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: KNOWN_SCHEMAS[t.name] ?? OPEN_SCHEMA }));
}

/** Marks the frame block and the tail's last block, on copies (the caller's blocks are not touched). */
function withCacheMarks(messages: ApiMessage[], frameKey: string): ApiMessage[] {
  const out = messages.map((m) => ({ role: m.role, content: [...m.content] }));
  const first = out[0]!;
  const frameAt = first.content.findIndex((b) => isFrame(first, b, frameKey));
  if (frameAt >= 0) first.content[frameAt] = { ...first.content[frameAt]!, cache_control: EPHEMERAL };
  const last = out.at(-1)!;
  const end = last.content.length - 1;
  if (end >= 0 && !(last === first && end === frameAt)) last.content[end] = { ...last.content[end]!, cache_control: EPHEMERAL };
  return out;
}

/** The whole request body for one model step. Pure: same input, same body. */
export function buildStepRequest(input: StepInput): StepRequest {
  return {
    model: input.model,
    max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: systemBlocks(input.sections, input.ownSection),
    tools: toolSchemas(input.tools),
    messages: withCacheMarks(stepMessages(input), input.frameKey),
    stream: false,
  };
}

// ---- the response, as turn.step chunks ----

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'compaction' | 'refusal' | 'model_context_window_exceeded' | null;
export type StepUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string };
export type StepChunk =
  | { kind: 'text'; index: number; text: string }
  | { kind: 'tool'; index: number; id: string; name: string }
  | { kind: 'input'; index: number; json: string }
  | { kind: 'stop'; stopReason: StopReason; usage: StepUsage | null };
export type StepResult = { turnId: string; index: number; answer: string; toolUses: Array<{ name: string; input: unknown }>; stopReason: StopReason; usage: StepUsage | null };

/** A Messages API response body, as far as this mode reads it. */
export type ApiResponse = { model?: string; stop_reason?: string | null; content?: Block[]; usage?: Record<string, unknown>; error?: unknown };

const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'compaction', 'refusal', 'model_context_window_exceeded']);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function usageOf(u: Record<string, unknown> | undefined): Omit<StepUsage, 'model'> {
  return {
    input_tokens: count(u?.input_tokens),
    output_tokens: count(u?.output_tokens),
    cache_read_input_tokens: count(u?.cache_read_input_tokens),
    cache_creation_input_tokens: count(u?.cache_creation_input_tokens),
  };
}

/**
 * The whole response as the chunks a `turn.step` hook yields (text, tool + input, stop) and the
 * step's result. Each block is yielded whole: `$.http.fetch` hands the body over only once it is
 * complete, so nothing streams.
 */
export function stepChunks(resp: ApiResponse, step: { turnId: string; index: number; model: string }): { chunks: StepChunk[]; result: StepResult } {
  const chunks: StepChunk[] = [];
  let answer = '';
  const toolUses: StepResult['toolUses'] = [];
  for (const [index, b] of (resp.content ?? []).entries()) {
    if (b.type === 'text') {
      answer += String(b.text ?? '');
      chunks.push({ kind: 'text', index, text: String(b.text ?? '') });
    } else if (b.type === 'tool_use') {
      toolUses.push({ name: String(b.name), input: b.input ?? {} });
      chunks.push({ kind: 'tool', index, id: String(b.id), name: String(b.name) });
      chunks.push({ kind: 'input', index, json: JSON.stringify(b.input ?? {}) });
    }
  }
  const stopReason = (STOP_REASONS.has(String(resp.stop_reason)) ? resp.stop_reason : 'end_turn') as StopReason;
  const usage: StepUsage = { ...usageOf(resp.usage), model: resp.model ?? step.model };
  chunks.push({ kind: 'stop', stopReason, usage });
  return { chunks, result: { turnId: step.turnId, index: step.index, answer, toolUses, stopReason, usage } };
}

// ---- sending ----

export const MESSAGES_API = 'https://api.anthropic.com/v1/messages';

/**
 * The `$.http.fetch` init for one step: the body, and the session's opaque auth handle, which
 * Claude Code resolves to its own credential when it sends the request. No credential is read or
 * stored by the mod; there is no Authorization header here.
 */
export function stepFetchInit(auth: { handle: string; kind: string }, body: StepRequest) {
  return {
    method: 'POST' as const,
    auth: auth.handle,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(auth.kind === 'bearer' ? { 'anthropic-beta': 'oauth-2025-04-20' } : {}),
    },
    body: JSON.stringify(body),
  };
}

/** The response body as far as this mode reads it; a body that is not JSON becomes an error. */
export function parseStepResponse(text: string): ApiResponse {
  try {
    return JSON.parse(text) as ApiResponse;
  } catch {
    return { error: text.slice(0, 500) };
  }
}

/** Why a response can't be used for the step (Claude Code then sends the step itself), or null. */
export function stepFailure(status: number, response: ApiResponse): string | null {
  if (status === 200 && Array.isArray(response.content)) return null;
  return `HTTP ${status}: ${JSON.stringify(response.error ?? response).slice(0, 300)}`;
}

/** Where one request record goes, under the core's state directory for the session. */
export function requestLogPath(stateDir: string, now: number, turnId: string, index: number): string {
  return `${stateDir}/claude-per-step/${`${now}-${turnId}-${index}`.replace(/[^\w.-]/g, '_')}.json`;
}

// ---- the request log ----

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const TOKENISH = /(sk-ant-[\w-]+|Bearer\s+[\w.~+/=-]+)/g;
const USER_ID = /("user_id"\s*:\s*")[^"]*(")/g;
/**
 * The credential formats the Codex evidence redactor covers (regression/codex/analyze.ts
 * CREDENTIAL; this module cannot import it, and a unit test keeps the two alike): JWTs, bearer and
 * `sk-` keys, ChatGPT account ids, cookies, and any long unbroken token-like run.
 */
const CREDENTIAL = new RegExp(
  [
    String.raw`eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]*`,
    String.raw`\bBearer\s+[A-Za-z0-9._\-]+`,
    String.raw`\bsk-[A-Za-z0-9_\-]{16,}`,
    String.raw`chatgpt-account-id["':\s=]+[A-Za-z0-9\-]{8,}`,
    String.raw`"?account_id"?\s*[:=]\s*"?[A-Za-z0-9\-]{8,}`,
    String.raw`\b(?:set-)?cookie["':\s=]+[^\s"]{8,}`,
    String.raw`__Secure-[A-Za-z0-9_\-.]+=\S+`,
    String.raw`[A-Za-z0-9+/=_\-]{80,}`,
  ].join('|'),
  'gi',
);

/**
 * Removes e-mail addresses, bearer/API tokens, JWTs and the other credential formats above, and
 * metadata user ids, from logged text. The one redaction for Claude request evidence: the per-step
 * request log and the regression reports.
 */
export function redact(s: string): string {
  return s.replace(TOKENISH, '<REDACTED-TOKEN>').replace(CREDENTIAL, '<REDACTED-TOKEN>').replace(EMAIL, '<email>').replace(USER_ID, '$1<redacted>$2');
}

/** `redact` applied to every string of a JSON value (keys and values), so the result stays valid JSON; `user_id` values are dropped. */
function redactDeep(v: unknown): unknown {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [redact(k), k === 'user_id' ? '<redacted>' : redactDeep(x)]));
  return v;
}

export type RequestLogRecord = {
  kind: 'claude-per-step-request';
  mode: typeof PER_STEP_LABEL;
  at: string;
  sessionId: string;
  turnId: string;
  index: number;
  /** The Working Context revision the request was built from. */
  revision: number;
  status: number;
  ms: number;
  stopReason: string | null;
  usage: Omit<StepUsage, 'model'>;
  model: string | null;
  /** The request body as sent. Headers are not part of it; the auth handle is never logged. */
  body: unknown;
  /** The response's content, or its error. */
  response: unknown;
};

/**
 * One mod-built request as the eval reads it: body, status, timing and usage. Claude Code's cost
 * ledger and its raw-body dump never see these requests, so this record is how they are counted.
 */
export function requestLogRecord(r: {
  at: string;
  sessionId: string;
  turnId: string;
  index: number;
  revision: number;
  status: number;
  ms: number;
  body: StepRequest;
  response: ApiResponse;
}): RequestLogRecord {
  const rec: RequestLogRecord = {
    kind: 'claude-per-step-request',
    mode: PER_STEP_LABEL,
    at: r.at,
    sessionId: r.sessionId,
    turnId: r.turnId,
    index: r.index,
    revision: r.revision,
    status: r.status,
    ms: r.ms,
    stopReason: r.response.stop_reason ?? null,
    usage: usageOf(r.response.usage),
    model: r.response.model ?? null,
    body: r.body,
    response: r.response.content ?? { error: r.response.error ?? null },
  };
  return redactDeep(JSON.parse(JSON.stringify(rec))) as RequestLogRecord;
}

// ---- the switch ----

export const MODE_ENV = 'CONTEXT_ENGINE_CLAUDE_MODE';

/** Per-step mode is opt-in: `CONTEXT_ENGINE_CLAUDE_MODE` decides when set, else the plugin's `mode` option. */
export function perStepOn(env: string | undefined, option: unknown): boolean {
  const v = env !== undefined && env.trim() !== '' ? env : typeof option === 'string' ? option : '';
  return v.trim().toLowerCase() === 'per-step';
}


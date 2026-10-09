// Test helpers (not part of the public interface). Every test gets fresh temp dirs; nothing
// touches the real home directory or XDG state.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FaultPlan } from './process-faults.ts';

const made: string[] = [];

// Each test file runs in its own process. Every directory it made goes when that process exits.
process.on('exit', () => {
  for (const dir of made) {
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (e) { process.stderr.write(`could not remove test directory ${dir}: ${(e as Error).message}\n`); }
  }
});

export function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `ce-${label}-`)));
  made.push(dir);
  return dir;
}

export function fixture() {
  const stateDir = join(tempDir('state'), 'context-engine');
  const projectRoot = tempDir('project');
  return { stateDir, projectRoot };
}

export const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const PROCESS_FAULTS = fileURLToPath(new URL('./process-faults.ts', import.meta.url));

export interface Finished { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

let inputs: { dir: string; next: number } | undefined;

/**
 * Starts the core CLI in its own process group, under a FaultPlan when one is given (process-faults.ts).
 * Stdin is a file, so the child reads its whole input even while this process is blocked.
 */
export function startCli(f: ReturnType<typeof fixture>, args: string[], opts: { input?: string; fault?: FaultPlan } = {}): { child: ChildProcess; done: Promise<Finished> } {
  inputs ??= { dir: tempDir('cli-input'), next: 0 };
  const inputPath = join(inputs.dir, String(inputs.next++));
  writeFileSync(inputPath, opts.input ?? '');
  const stdin = openSync(inputPath, 'r');
  const child = spawn(process.execPath, [...(opts.fault ? ['--import', PROCESS_FAULTS] : []), CLI, ...args], {
    cwd: f.projectRoot,
    detached: true,
    stdio: [stdin, 'pipe', 'pipe'],
    env: {
      ...process.env,
      CONTEXT_ENGINE_STATE_DIR: f.stateDir,
      XDG_STATE_HOME: '/nonexistent-should-not-be-used',
      CONTEXT_ENGINE_EXPERIMENTS: '',
      CONTEXT_ENGINE_TEST_PROJECT: '',
      CE_TEST_FAULT: opts.fault ? JSON.stringify(opts.fault) : '',
    },
  });
  let stdout = '', stderr = '';
  child.stdout!.on('data', (d) => (stdout += d));
  child.stderr!.on('data', (d) => (stderr += d));
  closeSync(stdin);
  const done = new Promise<Finished>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

/** A live process to name as a session owner. It exits by itself after a minute. */
export function ownerProcess(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore', detached: true });
}

/** SIGKILLs a child's whole process group and waits until the child has exited. */
export async function stopGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
  await exited;
}

export async function waitForFile(path: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Every Event Log row. Throws unless the log ends with a newline and every line is JSON. */
export function eventLog(path: string): Array<Record<string, any>> {
  const text = readFileSync(path, 'utf8');
  if (!text.endsWith('\n')) throw new Error('the Event Log ends with an unterminated line');
  return text.slice(0, -1).split('\n').map((line) => JSON.parse(line) as Record<string, any>);
}

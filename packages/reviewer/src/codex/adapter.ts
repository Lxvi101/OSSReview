import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ReviewFinding, ReviewResult, Reviewer, ReviewerInput } from '../port.js';
import { SubmitFindingsInputSchema, type SubmitFindingsInput } from '../claude/findingsSchema.js';
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from '../claude/prompt.js';
import { FINDINGS_JSON_SCHEMA } from './jsonSchema.js';

export interface CodexReviewerOptions {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly defaultModel: string;
  readonly timeoutMs: number;
}

interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

export class CodexReviewer implements Reviewer {
  readonly name = 'codex-cli';
  readonly version = PROMPT_VERSION;

  constructor(private readonly opts: CodexReviewerOptions) {}

  async review(input: ReviewerInput): Promise<ReviewResult> {
    const started = Date.now();
    const model = input.settings.model ?? this.opts.defaultModel;
    const tempDir = await mkdtemp(join(tmpdir(), 'gcr-codex-'));
    const schemaPath = join(tempDir, 'findings.schema.json');
    const outputPath = join(tempDir, 'last-message.json');
    await writeFile(schemaPath, JSON.stringify(FINDINGS_JSON_SCHEMA), 'utf8');

    const userPrompt = buildUserPrompt({
      pr: input.pr,
      diff: input.diff,
      ...(input.settings.promptAddendum !== undefined ? { addendum: input.settings.promptAddendum } : {}),
    });
    const prompt = `${SYSTEM_PROMPT}\n\n${userPrompt}`;
    const timeoutMs = Math.min(this.opts.timeoutMs, input.settings.walClockMs ?? this.opts.timeoutMs);

    try {
      const result = await runProcess(
        this.opts.binaryPath,
        [
          'exec',
          '--skip-git-repo-check',
          '--ephemeral',
          '--sandbox',
          'read-only',
          '--ask-for-approval',
          'never',
          '--output-schema',
          schemaPath,
          '--output-last-message',
          outputPath,
          '--cd',
          input.workspaceDir,
          '--model',
          model,
          '-',
        ],
        {
          stdin: prompt,
          env: buildCodexEnv(this.opts.homePath),
          timeoutMs,
          signal: input.signal,
        },
      );
      if (result.timedOut) {
        throw new Error(`Codex reviewer timed out after ${timeoutMs}ms`);
      }
      if (result.code !== 0) {
        throw new Error(
          `Codex reviewer failed (code=${result.code ?? 'null'}, signal=${result.signal ?? 'null'}): ${result.stderr.trim()}`,
        );
      }

      const raw = await readFile(outputPath, 'utf8').catch(() => result.stdout);
      const parsedJson = parseStructuredJson(raw);
      const parsed = SubmitFindingsInputSchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new Error(`Codex reviewer output failed schema validation: ${parsed.error.message}`);
      }

      return finalize(parsed.data, {
        reviewerName: this.name,
        reviewerVersion: this.version,
        model,
        durationMs: Date.now() - started,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

function finalize(
  data: SubmitFindingsInput,
  meta: ReviewResult['meta'],
): ReviewResult {
  const findings: ReviewFinding[] = data.findings.map((f) => ({
    filePath: f.filePath,
    severity: f.severity,
    body: f.body,
    ...(f.lineStart !== undefined ? { lineStart: f.lineStart } : {}),
    ...(f.lineEnd !== undefined ? { lineEnd: f.lineEnd } : {}),
    ...(f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
    ...(f.category !== undefined ? { category: f.category } : {}),
  }));
  return { summary: data.summary, findings, meta };
}

function parseStructuredJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Codex reviewer produced empty output');
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]);
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('Codex reviewer produced non-JSON output');
  }
}

function buildCodexEnv(homePath: string | undefined): NodeJS.ProcessEnv {
  const home = homePath?.trim();
  return {
    ...process.env,
    ...(home ? { CODEX_HOME: resolveHome(home) } : {}),
  };
}

function resolveHome(path: string): string {
  const home = process.env.HOME ?? '';
  if (path === '~') return home;
  if (path.startsWith('~/')) return resolve(home, path.slice(2));
  return resolve(path);
}

function runProcess(
  command: string,
  args: readonly string[],
  opts: {
    readonly stdin: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  },
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      env: opts.env,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, opts.timeoutMs);

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      opts.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      killChild(child);
      settle(() => reject(new Error('Codex reviewer aborted')));
    };

    if (opts.signal.aborted) {
      onAbort();
      return;
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      settle(() => reject(err));
    });
    child.once('close', (code, signal) => {
      settle(() => resolveResult({ stdout, stderr, code, signal, timedOut }));
    });
    child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

function killChild(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

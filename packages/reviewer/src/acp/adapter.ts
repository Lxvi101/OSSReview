/**
 * Generic Agent Client Protocol (ACP) adapter for the `Reviewer` port.
 *
 * Spawns any ACP-compliant coding agent (GitHub Copilot CLI via
 * `copilot --acp`, or any `custom` agent) as a subprocess and drives it over
 * JSON-RPC/stdio with the official `@agentclientprotocol/sdk` client.
 *
 * Same trust model as the other adapters (see `../port.ts`): the agent runs
 * in the ephemeral workspace with no GitHub token and no write/exec tools. We
 * auto-allow tool calls (read-only inspection) — equivalent to the Claude
 * path's `permissionMode: 'dontAsk'` — because the safety boundary here is
 * architectural, not per-tool.
 *
 * Structured output: there is no universal MCP/`--output-schema` mechanism
 * across ACP agents, so we ask for the findings as a single JSON object in the
 * final assistant message and parse + schema-validate it (one repair turn),
 * exactly like the Codex adapter does.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { type SubmitFindingsInput, SubmitFindingsInputSchema } from '../claude/findingsSchema.js';
import type { ReviewFinding, ReviewResult, Reviewer, ReviewerInput } from '../port.js';
import type { AcpAgentPreset } from './presets.js';
import { ACP_SYSTEM_PROMPT, PROMPT_VERSION, buildUserPrompt } from './prompt.js';

export interface AcpReviewerOptions {
  readonly preset: AcpAgentPreset;
  /** Sets HOME for the agent process so its CLI login persists/loads. */
  readonly homePath?: string;
  /** Recorded in `meta.model`; most ACP agents pick the model themselves. */
  readonly defaultModel?: string;
  /** Hard wall-clock cap (ms) for one review. */
  readonly timeoutMs: number;
}

export class AcpReviewer implements Reviewer {
  readonly name: string;
  readonly version = PROMPT_VERSION;

  constructor(private readonly opts: AcpReviewerOptions) {
    this.name = `acp-${opts.preset.id}`;
  }

  async review(input: ReviewerInput): Promise<ReviewResult> {
    const started = Date.now();
    const model = input.settings.model ?? this.opts.defaultModel ?? 'agent-default';
    const userPrompt = buildUserPrompt({
      pr: input.pr,
      diff: input.diff,
      ...(input.settings.promptAddendum !== undefined
        ? { addendum: input.settings.promptAddendum }
        : {}),
    });
    const basePrompt = `${ACP_SYSTEM_PROMPT}\n\n${userPrompt}`;
    const timeoutMs = Math.min(
      this.opts.timeoutMs,
      input.settings.walClockMs ?? this.opts.timeoutMs,
    );

    const { preset } = this.opts;
    const child = spawn(preset.command, [...preset.args], {
      cwd: input.workspaceDir,
      env: buildEnv(this.opts.homePath),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stderrChunks: string[] = [];
    child.stderr.on('data', (c: Buffer) => {
      if (stderrChunks.length < 200) stderrChunks.push(c.toString('utf8'));
    });

    // ENOENT etc. surfaces here, not via close.
    let spawnError: Error | null = null;
    child.once('error', (err: Error) => {
      spawnError = err;
    });

    const wallController = new AbortController();
    const wallTimer = setTimeout(() => wallController.abort(), timeoutMs);
    const onCallerAbort = (): void => wallController.abort();
    input.signal.addEventListener('abort', onCallerAbort, { once: true });

    let buffer = '';
    let timedOut = false;

    const inputStream = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const outputStream = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(inputStream, outputStream);

    const client: acp.Client = {
      requestPermission(
        params: acp.RequestPermissionRequest,
      ): Promise<acp.RequestPermissionResponse> {
        // Auto-approve: the reviewer is sandboxed and tokenless by design.
        const opt =
          params.options.find((o) => o.kind === 'allow_always') ??
          params.options.find((o) => o.kind === 'allow_once') ??
          params.options[0];
        return Promise.resolve(
          opt
            ? { outcome: { outcome: 'selected', optionId: opt.optionId } }
            : { outcome: { outcome: 'cancelled' } },
        );
      },
      sessionUpdate(params: acp.SessionNotification): Promise<void> {
        const u = params.update;
        try {
          switch (u.sessionUpdate) {
            case 'agent_message_chunk':
              if (u.content.type === 'text') {
                buffer += u.content.text;
                if (input.onEvent && u.content.text.trim())
                  input.onEvent({ kind: 'assistant_text', payload: { text: u.content.text } });
              }
              break;
            case 'agent_thought_chunk':
              if (u.content.type === 'text' && input.onEvent && u.content.text.trim())
                input.onEvent({
                  kind: 'assistant_thinking',
                  payload: { thinking: u.content.text },
                });
              break;
            case 'tool_call':
              if (input.onEvent)
                input.onEvent({
                  kind: 'tool_use',
                  payload: { name: u.title ?? u.kind ?? '?', id: u.toolCallId },
                });
              break;
            case 'tool_call_update':
              if (input.onEvent)
                input.onEvent({
                  kind: 'tool_result',
                  payload: { tool_use_id: u.toolCallId, preview: String(u.status ?? '') },
                });
              break;
            case 'plan':
              if (input.onEvent)
                input.onEvent({ kind: 'sdk_status', payload: { subtype: 'plan' } });
              break;
            default:
              break;
          }
        } catch {
          // recorder is best-effort UX
        }
        return Promise.resolve();
      },
      readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
        return readWithinWorkspace(input.workspaceDir, params);
      },
    };

    const connection = new acp.ClientSideConnection(() => client, stream);
    let sessionId: string | null = null;
    const abortListener = (): void => {
      if (sessionId) void connection.cancel({ sessionId }).catch(() => {});
    };
    wallController.signal.addEventListener(
      'abort',
      () => {
        timedOut = !input.signal.aborted;
        abortListener();
      },
      { once: true },
    );

    try {
      if (spawnError) throw spawnError;

      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
      });

      const session = await connection.newSession({
        cwd: input.workspaceDir,
        mcpServers: [],
      });
      sessionId = session.sessionId;

      let attempt = 0;
      let lastError: unknown = null;
      while (attempt < 2) {
        attempt++;
        buffer = '';
        const text =
          attempt === 1
            ? basePrompt
            : `Your previous answer failed validation: ${String(lastError)}\n\nReply again with ONLY the corrected \`\`\`json block, conforming exactly to the schema.`;

        const res = await connection.prompt({
          sessionId,
          prompt: [{ type: 'text', text }],
        });

        if (res.stopReason === 'cancelled') {
          throw new Error(
            timedOut
              ? `ACP reviewer (${preset.label}) timed out after ${timeoutMs}ms`
              : `ACP reviewer (${preset.label}) was cancelled`,
          );
        }

        let parsedJson: unknown;
        try {
          parsedJson = parseStructuredJson(buffer);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          continue;
        }
        const parsed = SubmitFindingsInputSchema.safeParse(parsedJson);
        if (!parsed.success) {
          lastError = parsed.error.message;
          continue;
        }

        return finalize(parsed.data, {
          reviewerName: this.name,
          reviewerVersion: this.version,
          model,
          durationMs: Date.now() - started,
        });
      }

      const tail = stderrChunks.join('').slice(-1000).trim();
      throw new Error(
        `ACP reviewer (${preset.label}) produced no valid findings after retry: ${String(lastError)}${
          tail ? ` | stderr_tail=${tail}` : ''
        }`,
      );
    } finally {
      clearTimeout(wallTimer);
      input.signal.removeEventListener('abort', onCallerAbort);
      killChild(child);
    }
  }
}

function finalize(data: SubmitFindingsInput, meta: ReviewResult['meta']): ReviewResult {
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

/** Extract a JSON object from possibly-fenced, possibly-chatty agent text. */
function parseStructuredJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('ACP agent produced empty output');
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through to brace scan */
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('ACP agent produced non-JSON output');
  }
}

async function readWithinWorkspace(
  workspaceDir: string,
  params: acp.ReadTextFileRequest,
): Promise<acp.ReadTextFileResponse> {
  const abs = isAbsolute(params.path) ? params.path : resolve(workspaceDir, params.path);
  const rel = relative(workspaceDir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path outside workspace: ${params.path}`);
  }
  let content = await readFile(abs, 'utf8');
  const line = params.line ?? null;
  const limit = params.limit ?? null;
  if (line !== null || limit !== null) {
    const lines = content.split('\n');
    const from = line !== null ? Math.max(0, line - 1) : 0;
    const to = limit !== null ? from + limit : lines.length;
    content = lines.slice(from, to).join('\n');
  }
  return { content };
}

function buildEnv(homePath: string | undefined): NodeJS.ProcessEnv {
  const home = homePath?.trim();
  return {
    ...process.env,
    ...(home ? { HOME: resolveHome(home) } : {}),
  };
}

function resolveHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function killChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

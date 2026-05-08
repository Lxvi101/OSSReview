import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ClaudeDriver, ClaudeDriverRequest, ClaudeDriverResponse } from './adapter.js';
import { FindingSchema } from './findingsSchema.js';

/**
 * Real driver against `@anthropic-ai/claude-agent-sdk`.
 *
 * Registers a single in-process MCP tool (`submit_findings`) and runs the
 * agent with read-only file tools and no Edit/Write/Bash. The agent has no
 * write capability and cannot shell out.
 */

const SERVER_NAME = 'gcr_review';
const TOOL_NAME = 'submit_findings';

const FULL_TOOL_ID = `mcp__${SERVER_NAME}__${TOOL_NAME}`;

const READ_ONLY_FILE_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'LS'];

const DISALLOWED_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash',
  'BashOutput',
  'KillShell',
  'WebFetch',
  'WebSearch',
];

export const realClaudeDriver: ClaudeDriver = async (
  req: ClaudeDriverRequest,
): Promise<ClaudeDriverResponse> => {
  let captured: unknown = null;
  const captureDeferred = createDeferred<void>();

  const env = {
    ...process.env,
    ...(req.homePath?.trim() ? { HOME: resolveHome(req.homePath) } : {}),
  };

  const submitTool = tool(
    TOOL_NAME,
    'Submit your final code-review findings. Call this exactly once when you are done reviewing.',
    {
      summary: z.object({
        body: z.string().min(1).max(20_000),
        verdict: z.enum(['approve', 'request_changes', 'comment']),
      }),
      findings: z.array(FindingSchema).max(200),
    },
    async (args) => {
      captured = args;
      captureDeferred.resolve();
      return {
        content: [{ type: 'text' as const, text: `recorded ${args.findings.length} findings` }],
      };
    },
  );

  const mcpServer = createSdkMcpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    tools: [submitTool],
  });

  const wallClockController = new AbortController();
  const wallTimer = setTimeout(() => wallClockController.abort(), req.walClockMs);

  const combined = new AbortController();
  const onCallerAbort = () => combined.abort();
  const onWallAbort = () => combined.abort();
  req.signal.addEventListener('abort', onCallerAbort, { once: true });
  wallClockController.signal.addEventListener('abort', onWallAbort, { once: true });

  const start = Date.now();

  let lastResult: {
    subtype?: string | undefined;
    result?: string | undefined;
    errors?: string[] | undefined;
  } | null = null;
  const stderrChunks: string[] = [];

  try {
    const sdkQuery = query({
      prompt: req.userPrompt,
      options: {
        model: req.model,
        cwd: req.workspaceDir,
        ...(req.binaryPath?.trim()
          ? { pathToClaudeCodeExecutable: resolveBinaryOnPath(req.binaryPath, env) }
          : {}),
        systemPrompt: req.systemPrompt,
        settingSources: [],
        mcpServers: { [SERVER_NAME]: mcpServer },
        allowedTools: [FULL_TOOL_ID, ...READ_ONLY_FILE_TOOLS],
        disallowedTools: [...DISALLOWED_TOOLS],
        maxTurns: req.maxTurns,
        permissionMode: 'dontAsk',
        abortController: combined,
        env,
        stderr: (data: string) => {
          stderrChunks.push(data);
        },
      },
    });

    for await (const msg of sdkQuery) {
      if (req.onEvent) {
        try {
          emitForLiveView(msg, req.onEvent);
        } catch {
          // recorder is best-effort UX
        }
      }

      if (msg.type === 'result') {
        const m = msg as unknown as {
          subtype?: string;
          result?: string;
          errors?: string[];
        };
        lastResult = { subtype: m.subtype, result: m.result, errors: m.errors };
        break;
      }
      if (captured !== null) {
        try {
          await sdkQuery.return(undefined);
        } catch {
          /* swallow */
        }
        break;
      }
    }

    if (captured === null) {
      const got = await Promise.race([
        captureDeferred.promise.then(() => 'captured' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
      ]);
      if (got === 'timeout') {
        const subtype = lastResult?.subtype ?? 'unknown';
        const sdkErrors = (lastResult?.errors ?? []).join('; ');
        const tail = stderrChunks.join('').slice(-1500).trim();
        const text = (lastResult?.result ?? '').slice(-500).trim();
        const detail = [
          `subtype=${subtype}`,
          sdkErrors && `errors=${sdkErrors}`,
          text && `last_text=${text}`,
          tail && `stderr_tail=${tail}`,
        ]
          .filter(Boolean)
          .join(' | ');
        throw new Error(
          `Claude finished without calling submit_findings (${detail || 'no diagnostics'})`,
        );
      }
    }
  } finally {
    clearTimeout(wallTimer);
    req.signal.removeEventListener('abort', onCallerAbort);
    wallClockController.signal.removeEventListener('abort', onWallAbort);
  }

  return {
    toolInput: captured,
    durationMs: Date.now() - start,
  };
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resolveHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function emitForLiveView(msg: unknown, onEvent: NonNullable<ClaudeDriverRequest['onEvent']>): void {
  const m = msg as { type?: string };
  if (m.type === 'assistant') {
    const am = msg as { message?: { content?: ReadonlyArray<unknown> } };
    const blocks = am.message?.content ?? [];
    for (const blockUnknown of blocks) {
      const b = blockUnknown as { type?: string };
      if (b.type === 'text') {
        const text = (blockUnknown as { text?: string }).text ?? '';
        if (text.trim()) onEvent({ kind: 'assistant_text', payload: { text } });
      } else if (b.type === 'thinking') {
        const thinking = (blockUnknown as { thinking?: string }).thinking ?? '';
        if (thinking.trim()) onEvent({ kind: 'assistant_thinking', payload: { thinking } });
      } else if (b.type === 'tool_use') {
        const tu = blockUnknown as { name?: string; input?: unknown; id?: string };
        onEvent({
          kind: 'tool_use',
          payload: {
            name: tu.name ?? '?',
            id: tu.id ?? null,
            input: tu.input ?? null,
          },
        });
      }
    }
    return;
  }
  if (m.type === 'user') {
    const um = msg as { message?: { content?: ReadonlyArray<unknown> } };
    const blocks = um.message?.content ?? [];
    for (const blockUnknown of blocks) {
      const b = blockUnknown as { type?: string };
      if (b.type === 'tool_result') {
        const tr = blockUnknown as {
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        };
        const preview = previewToolResult(tr.content);
        onEvent({
          kind: 'tool_result',
          payload: {
            tool_use_id: tr.tool_use_id ?? null,
            is_error: !!tr.is_error,
            preview,
          },
        });
      }
    }
    return;
  }
  if (m.type === 'system' || m.type === 'status') {
    const sm = msg as { subtype?: string; message?: string };
    onEvent({
      kind: 'sdk_status',
      payload: { subtype: sm.subtype ?? m.type, message: sm.message ?? '' },
    });
  }
}

function previewToolResult(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 1500);
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (c && typeof c === 'object' && 'text' in c) {
          return String((c as { text: unknown }).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .slice(0, 1500);
  }
  try {
    return JSON.stringify(content).slice(0, 1500);
  } catch {
    return '';
  }
}

function resolveBinaryOnPath(name: string, env: NodeJS.ProcessEnv): string {
  const trimmed = name.trim();
  if (!trimmed) return name;
  if (isAbsolute(trimmed)) return trimmed;
  if (trimmed.includes('/') || trimmed.includes('\\')) return trimmed;

  const pathDirs = (env.PATH ?? process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, trimmed);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // ENOENT, EACCES — try next
    }
  }
  return trimmed;
}

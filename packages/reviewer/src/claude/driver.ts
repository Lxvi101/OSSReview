import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { ClaudeDriver, ClaudeDriverRequest, ClaudeDriverResponse } from './adapter.js';
import { FindingSchema } from './findingsSchema.js';

/**
 * Real driver against `@anthropic-ai/claude-agent-sdk`.
 *
 * How it works:
 *   - We register a single in-process MCP tool, `submit_findings`, whose zod
 *     schema mirrors the contract in `findingsSchema.ts`. Its handler is a
 *     closure that captures the call's input and resolves a promise.
 *   - We invoke `query()` with the system prompt, the agent's working
 *     directory pinned to the workspace, file-write tools disabled
 *     (`disallowedTools`), and ONLY our submit tool plus read-only file
 *     tools allowed (`allowedTools`).
 *   - We iterate messages until either `submit_findings` is called or the
 *     `result` message arrives. The `result` message carries cost + tokens
 *     even when the agent didn't call our tool (e.g. when it gave up).
 *
 * Key invariant: the agent has NO write capability. It cannot edit files or
 * run bash. File reading happens through Claude Code's read-only filesystem
 * tools with cwd pinned to the prepared workspace.
 */

const SERVER_NAME = 'gcr_review';
const TOOL_NAME = 'submit_findings';

// MCP-namespaced tool id format used by the SDK.
const FULL_TOOL_ID = `mcp__${SERVER_NAME}__${TOOL_NAME}`;

// Read-only file tools we allow alongside our submit tool. Anything not
// listed here is disallowed by exclusion (the SDK's default permission mode
// is `dontAsk` here, see opts below).
const READ_ONLY_FILE_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'LS'];

// Anything that mutates the host or shells out is explicitly denied as well,
// in case the SDK's default permission set ever expands.
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
  // Per-call mutable state; reset on every driver invocation so retries
  // (the adapter's repair turn) don't see stale values.
  let captured: unknown = null;
  const captureDeferred = createDeferred<void>();

  const env = {
    ...process.env,
    ...(req.apiKey !== undefined ? { ANTHROPIC_API_KEY: req.apiKey } : {}),
    ...(req.homePath !== undefined && req.homePath.trim()
      ? { HOME: resolveHome(req.homePath) }
      : {}),
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

  // Wall-clock cap: if we don't get the tool call before this fires, abort
  // the SDK run and surface a retryable error to the caller.
  const wallClockController = new AbortController();
  const wallTimer = setTimeout(() => wallClockController.abort(), req.walClockMs);

  // Combine caller signal + wall-clock signal.
  const combined = new AbortController();
  const onCallerAbort = () => combined.abort();
  const onWallAbort = () => combined.abort();
  req.signal.addEventListener('abort', onCallerAbort, { once: true });
  wallClockController.signal.addEventListener('abort', onWallAbort, { once: true });

  const start = Date.now();
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;

  // Track the result message so we can surface its actual error subtype if
  // Claude bailed without calling our tool.
  let lastResult: {
    subtype?: string | undefined;
    result?: string | undefined;
    errors?: string[] | undefined;
  } | null = null;
  // Capture stderr for diagnostics — `stderr ended without tool call` is
  // useless on its own; the actual reason is usually in the SDK's stderr.
  const stderrChunks: string[] = [];

  try {
    // SDK message stream. We build a fresh `query` per driver call.
    const sdkQuery = query({
      prompt: req.userPrompt,
      options: {
        model: req.model,
        cwd: req.workspaceDir,
        // The SDK's `pathToClaudeCodeExecutable` expects an absolute path,
        // not a name to look up on PATH. If the operator configured a bare
        // name (e.g. `CLAUDE_CODE_BINARY=claude`), resolve it ourselves —
        // otherwise the SDK errors with "Claude Code native binary not
        // found at claude" even when the binary is on PATH.
        ...(req.binaryPath !== undefined && req.binaryPath.trim()
          ? { pathToClaudeCodeExecutable: resolveBinaryOnPath(req.binaryPath, env) }
          : {}),
        // Plain string, not preset+append. The `claude_code` preset primes
        // Claude for general code-editing (Edit/Write/Bash) which we've
        // disallowed — that mismatch was making it end its turn early
        // without calling `submit_findings`.
        systemPrompt: req.systemPrompt,
        // No setting sources: we don't want CLAUDE.md / project-level
        // settings on the host (or in the user's home) to override our
        // review-focused configuration with general-purpose instructions.
        settingSources: [],
        // One MCP server, one tool. plus the read-only file tools.
        mcpServers: { [SERVER_NAME]: mcpServer },
        allowedTools: [FULL_TOOL_ID, ...READ_ONLY_FILE_TOOLS],
        disallowedTools: [...DISALLOWED_TOOLS],
        maxTurns: req.maxTurns,
        // dontAsk: deny anything the model attempts that we haven't allowed.
        permissionMode: 'dontAsk',
        abortController: combined,
        env,
        stderr: (data: string) => {
          stderrChunks.push(data);
        },
      },
    });

    // Iterate until tool call captured or stream ends.
    for await (const msg of sdkQuery) {
      if (msg.type === 'result') {
        // 'result' is always last. Capture cost regardless of subtype.
        costUsd = msg.total_cost_usd ?? 0;
        for (const usage of Object.values(msg.modelUsage ?? {})) {
          inputTokens += usage.inputTokens ?? 0;
          outputTokens += usage.outputTokens ?? 0;
          cachedInputTokens += usage.cacheReadInputTokens ?? 0;
        }
        // Stash the subtype + payload so we can surface a real error if
        // the tool was never called. SDK shape varies by subtype; read
        // defensively.
        const m = msg as unknown as {
          subtype?: string;
          result?: string;
          errors?: string[];
        };
        lastResult = { subtype: m.subtype, result: m.result, errors: m.errors };
        break;
      }
      // We don't need to do anything with assistant messages — the tool
      // handler captures input via closure as soon as Claude invokes it.
      if (captured !== null) {
        // Race: we have the input. Don't wait for the result message; we
        // could but it's nicer to short-circuit. Drain the rest of the
        // stream to give the SDK a chance to clean up.
        // (The SDK's AsyncGenerator handles abort cleanly.)
        try { await sdkQuery.return(undefined); } catch {/* swallow */}
        break;
      }
    }

    // If the tool was called *during* a `result` message we already captured
    // it, otherwise wait briefly to absorb a tool call that's about to fire.
    if (captured === null) {
      const got = await Promise.race([
        captureDeferred.promise.then(() => 'captured' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
      ]);
      if (got === 'timeout') {
        // Build a useful error: SDK result subtype + any stderr we caught.
        // The bare "stream ended" message hides the real cause (auth fail,
        // rate limit, max turns, max budget, etc.).
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
    inputTokens,
    outputTokens,
    cachedInputTokens,
    costUsdMicros: Math.round(costUsd * 1_000_000),
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

/**
 * Resolve a bare command name (e.g. `claude`) to its absolute path by
 * walking PATH the way the OS would. Falls back to the input on miss so
 * the SDK's own error path runs instead of ours hiding it.
 *
 * Why: the Claude Code SDK's `pathToClaudeCodeExecutable` does NOT do PATH
 * lookup itself — it tries the value as a literal file path. So
 * `CLAUDE_CODE_BINARY=claude` (the natural default) errors with "Claude
 * Code native binary not found at claude" even when claude is on PATH.
 */
function resolveBinaryOnPath(name: string, env: NodeJS.ProcessEnv): string {
  const trimmed = name.trim();
  if (!trimmed) return name;
  if (isAbsolute(trimmed)) return trimmed;
  // If the value contains a path separator, it's already a relative-or-absolute
  // path the caller composed; let it through unchanged.
  if (trimmed.includes('/') || trimmed.includes('\\')) return trimmed;

  const pathDirs = (env.PATH ?? process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, trimmed);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // ENOENT, EACCES, ELOOP — try next directory
    }
  }
  // Couldn't find it. Return the original; the SDK will surface a clear error.
  return trimmed;
}

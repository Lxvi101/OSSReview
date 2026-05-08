/**
 * Claude Code SDK adapter for the `Reviewer` port.
 *
 * Runs in-process in the worker; drives the locally installed `claude` binary
 * through `@anthropic-ai/claude-agent-sdk`. Auth comes from whichever Claude
 * Code home the worker can read.
 */

import type { ReviewFinding, ReviewResult, Reviewer, ReviewerInput } from '../port.js';
import { type SubmitFindingsInput, SubmitFindingsInputSchema } from './findingsSchema.js';
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

/** Optional injection point: a function returning the SDK driver. */
export type ClaudeDriver = (req: ClaudeDriverRequest) => Promise<ClaudeDriverResponse>;

export interface ClaudeDriverRequest {
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly workspaceDir: string;
  readonly toolSchema: unknown;
  readonly maxTurns: number;
  readonly maxOutputTokens: number;
  readonly walClockMs: number;
  readonly signal: AbortSignal;
  readonly onEvent?: ReviewerInput['onEvent'];
}

export interface ClaudeDriverResponse {
  readonly toolInput: unknown;
  readonly durationMs: number;
}

export interface ClaudeReviewerOptions {
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly defaultModel: string;
  /** Override the SDK driver (real implementation lives in `./driver.ts`). */
  readonly driver?: ClaudeDriver;
}

export class ClaudeReviewer implements Reviewer {
  readonly name = 'claude-code';
  readonly version = PROMPT_VERSION;
  private readonly driver: ClaudeDriver;

  constructor(private readonly opts: ClaudeReviewerOptions) {
    this.driver = opts.driver ?? defaultDriver;
  }

  async review(input: ReviewerInput): Promise<ReviewResult> {
    const model = input.settings.model ?? this.opts.defaultModel;
    const userPrompt = buildUserPrompt({
      pr: input.pr,
      diff: input.diff,
      ...(input.settings.promptAddendum !== undefined
        ? { addendum: input.settings.promptAddendum }
        : {}),
    });

    const baseRequest: ClaudeDriverRequest = {
      ...(this.opts.binaryPath !== undefined ? { binaryPath: this.opts.binaryPath } : {}),
      ...(this.opts.homePath !== undefined ? { homePath: this.opts.homePath } : {}),
      ...(input.onEvent !== undefined ? { onEvent: input.onEvent } : {}),
      model,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      workspaceDir: input.workspaceDir,
      toolSchema: SubmitFindingsInputSchema,
      maxTurns: input.settings.maxTurns ?? 30,
      maxOutputTokens: input.settings.maxOutputTokens ?? 64_000,
      walClockMs: input.settings.walClockMs ?? 20 * 60 * 1000,
      signal: input.signal,
    };

    let attempt = 0;
    let lastError: unknown = null;
    while (attempt < 2) {
      attempt++;
      const response = await this.driver(
        attempt === 1
          ? baseRequest
          : {
              ...baseRequest,
              userPrompt: `${userPrompt}\n\n## Previous attempt failed validation\n${String(lastError)}\n\nCall \`submit_findings\` again with valid input.`,
            },
      );

      const parsed = SubmitFindingsInputSchema.safeParse(response.toolInput);
      if (!parsed.success) {
        lastError = parsed.error.message;
        continue;
      }

      return finalize(parsed.data, response, model, this.name, this.version);
    }

    throw new Error(
      `Claude reviewer: tool input failed schema validation after retry: ${String(lastError)}`,
    );
  }
}

function finalize(
  data: SubmitFindingsInput,
  meta: ClaudeDriverResponse,
  model: string,
  name: string,
  version: string,
): ReviewResult {
  const findings: ReviewFinding[] = data.findings.map((f) => {
    const out: Mutable<ReviewFinding> = {
      filePath: f.filePath,
      severity: f.severity,
      body: f.body,
    };
    if (f.lineStart !== undefined) out.lineStart = f.lineStart;
    if (f.lineEnd !== undefined) out.lineEnd = f.lineEnd;
    if (f.suggestion !== undefined) out.suggestion = f.suggestion;
    if (f.category !== undefined) out.category = f.category;
    return out;
  });

  return {
    summary: data.summary,
    findings,
    meta: {
      reviewerName: name,
      reviewerVersion: version,
      model,
      durationMs: meta.durationMs,
    },
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

async function defaultDriver(req: ClaudeDriverRequest): Promise<ClaudeDriverResponse> {
  const { realClaudeDriver } = await import('./driver.js');
  return realClaudeDriver(req);
}

#!/usr/bin/env node
/**
 * `pnpm acp:selftest` — prove the ACP reviewer wiring end-to-end.
 *
 * By default it drives a built-in *fake* ACP agent (a subprocess speaking the
 * Agent Client Protocol via @agentclientprotocol/sdk) through the real
 * `AcpReviewer`, then asserts a valid ReviewResult comes back. No network, no
 * auth, no model — it exercises spawn → ndJsonStream → initialize →
 * newSession → prompt → permission → JSON parse → schema validation.
 *
 * To validate a *real* agent (e.g. before relying on Copilot in production):
 *
 *   pnpm acp:selftest --agent "copilot --acp"
 *
 * That runs the real agent against a tiny throwaway repo and prints whether it
 * returned schema-valid findings. Exit 0 = green, 1 = failure.
 *
 * Requires a prior build (`pnpm build`) so packages/reviewer/dist exists.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REVIEWER_ACP_DIST = join(REPO_ROOT, 'packages', 'reviewer', 'dist', 'acp', 'index.js');

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const D = (s) => `\x1b[2m${s}\x1b[0m`;

const agentArg = (() => {
  const a = process.argv.find((x) => x.startsWith('--agent='));
  if (a) return a.slice('--agent='.length);
  const i = process.argv.indexOf('--agent');
  return i >= 0 ? process.argv[i + 1] : null;
})();

// Resolve the SDK as the reviewer package sees it, so the fake agent (which
// runs from an out-of-tree temp dir) can import it by absolute path.
const SDK_URL = pathToFileURL(
  createRequire(REVIEWER_ACP_DIST).resolve('@agentclientprotocol/sdk'),
).href;

// A complete fake ACP agent: on prompt it does a tool call (to exercise
// permission + event mapping) then emits the findings as a fenced JSON block.
const FAKE_AGENT = `
import * as acp from ${JSON.stringify(SDK_URL)};
import { Readable, Writable } from 'node:stream';

const FINDINGS = {
  summary: { body: 'Self-test review. One nit found.', verdict: 'comment' },
  findings: [
    { filePath: 'src/index.js', lineStart: 1, severity: 'nit', body: 'Prefer const over var.' },
  ],
};

class FakeAgent {
  constructor(connection) { this.connection = connection; }
  async initialize() { return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }; }
  async newSession() { return { sessionId: 'selftest-1' }; }
  async authenticate() { return {}; }
  async setSessionMode() { return {}; }
  async cancel() {}
  async prompt(params) {
    const sessionId = params.sessionId;
    await this.connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Reading files', kind: 'read', status: 'pending' },
    });
    // Force a permission round-trip; the client must auto-allow.
    await this.connection.requestPermission({
      sessionId,
      toolCall: { toolCallId: 't1', title: 'Reading files', status: 'pending' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    await this.connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
    });
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Here are my findings:\\n\\n\\\`\\\`\\\`json\\n' + JSON.stringify(FINDINGS) + '\\n\\\`\\\`\\\`\\n' },
      },
    });
    return { stopReason: 'end_turn' };
  }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
new acp.AgentSideConnection((conn) => new FakeAgent(conn), stream);
`;

async function main() {
  process.stdout.write(
    `ACP self-test: ${B(agentArg ? `real agent → ${agentArg}` : 'built-in fake agent')}\n\n`,
  );

  let AcpReviewer;
  try {
    ({ AcpReviewer } = await import(pathToFileURL(REVIEWER_ACP_DIST).href));
  } catch (err) {
    process.stderr.write(
      `${R('fail')} cannot import ${D(REVIEWER_ACP_DIST)} — run ${B('pnpm build')} first\n${D(String(err))}\n`,
    );
    process.exit(1);
  }

  const dir = await mkdtemp(join(tmpdir(), 'gcr-acp-selftest-'));
  let preset;
  if (agentArg) {
    const [command, ...args] = agentArg.split(/\s+/).filter(Boolean);
    preset = { id: 'custom', label: 'real', command, args };
  } else {
    const fakePath = join(dir, 'fake-agent.mjs');
    await writeFile(fakePath, FAKE_AGENT, 'utf8');
    preset = { id: 'custom', label: 'fake', command: process.execPath, args: [fakePath] };
  }
  // A trivial workspace so a real agent has something to look at.
  await writeFile(join(dir, 'index.js'), 'var x = 1;\n', 'utf8');

  const events = [];
  const reviewer = new AcpReviewer({ preset, timeoutMs: 120_000 });

  try {
    const result = await reviewer.review({
      workspaceDir: dir,
      diff: 'diff --git a/index.js b/index.js\n+var x = 1;\n',
      pr: {
        owner: 'acme',
        repo: 'demo',
        number: 1,
        title: 'Self-test',
        description: 'n/a',
        authorLogin: 'tester',
        headSha: 'head',
        baseSha: 'base',
      },
      settings: {},
      onEvent: (e) => events.push(e.kind),
      signal: new AbortController().signal,
    });

    let ok = true;
    const check = (cond, label) => {
      process.stdout.write(`  ${cond ? G('ok') : R('FAIL')}  ${label}\n`);
      if (!cond) ok = false;
    };
    check(
      result?.summary?.verdict === 'comment' || typeof result?.summary?.verdict === 'string',
      'summary.verdict present',
    );
    check(Array.isArray(result?.findings), 'findings is an array');
    check(
      typeof result?.meta?.reviewerName === 'string' && result.meta.reviewerName.startsWith('acp-'),
      `meta.reviewerName = ${result?.meta?.reviewerName}`,
    );
    check(typeof result?.meta?.durationMs === 'number', 'meta.durationMs is numeric');
    if (!agentArg) {
      check(
        result.findings.length === 1 && result.findings[0].severity === 'nit',
        'fake findings round-tripped',
      );
      check(
        events.includes('tool_use') && events.includes('assistant_text'),
        `live events emitted (${[...new Set(events)].join(',')})`,
      );
    } else {
      process.stdout.write(
        `  ${D('info')} real agent returned ${result.findings.length} finding(s), verdict=${result.summary.verdict}\n`,
      );
    }

    process.stdout.write(
      `\n${ok ? G('PASS') : R('FAIL')} ACP wiring ${ok ? 'verified' : 'has problems'}\n`,
    );
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(
      `\n${R('FAIL')} review threw: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main();

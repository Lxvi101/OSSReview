/**
 * Built-in ACP agent presets.
 *
 * An ACP "agent" is just a subprocess we drive over JSON-RPC/stdio (see
 * `adapter.ts`). A preset is the command + args needed to start a given agent
 * in ACP mode. Anything that speaks the Agent Client Protocol can be wired in
 * here — or via the `custom` preset without touching code.
 *
 * Resolution precedence (per field): explicit env override → preset default.
 */

export type AcpAgentId = 'github-copilot' | 'custom';

export interface AcpAgentPreset {
  readonly id: AcpAgentId;
  /** Human label, e.g. for status checks and the live transcript. */
  readonly label: string;
  /** Executable to spawn (resolved against PATH by the OS / shell). */
  readonly command: string;
  /** Arguments that put the agent into ACP-over-stdio mode. */
  readonly args: readonly string[];
}

interface AcpEnvLike {
  readonly ACP_AGENT: AcpAgentId;
  readonly ACP_AGENT_COMMAND: string;
  readonly ACP_AGENT_ARGS: string;
}

const BUILTINS: Record<AcpAgentId, { label: string; command: string; args: readonly string[] }> = {
  // GitHub Copilot CLI — native ACP, public preview since 2026-01-28.
  // `copilot --acp` speaks ACP over stdio. Auth is whatever `copilot`
  // login the agent process can read (see ACP_AGENT_HOME).
  'github-copilot': { label: 'GitHub Copilot CLI', command: 'copilot', args: ['--acp'] },
  // Bring-your-own ACP agent. Command + args come entirely from env.
  custom: { label: 'Custom ACP agent', command: '', args: [] },
};

/**
 * Splits a shell-ish args string. Supports single/double quotes so values
 * with spaces survive (e.g. `--flag "a b"`); good enough for config, and we
 * never pass it to a shell.
 */
export function parseArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m = re.exec(raw);
  while (m !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
    m = re.exec(raw);
  }
  return out;
}

export function resolveAcpPreset(env: AcpEnvLike): AcpAgentPreset {
  const id = env.ACP_AGENT;
  const builtin = BUILTINS[id];
  const command = env.ACP_AGENT_COMMAND.trim() || builtin.command;
  const args = env.ACP_AGENT_ARGS.trim() ? parseArgs(env.ACP_AGENT_ARGS) : [...builtin.args];
  return { id, label: builtin.label, command, args };
}

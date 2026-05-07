# ADR 0005: One Docker container per review run

- Status: Superseded by host-local subscription-backed reviewers
- Date: 2026-05-03

## Context

> Superseded note: the default reviewer now runs local Claude Code / Codex CLI
> processes using the VPS user's subscription-backed CLI auth. This ADR remains
> as the design record for the legacy Anthropic API-key Docker sandbox path.

A review involves giving an LLM access to the contents of a pull request,
plus an Anthropic API key. Two threats:

1. **Prompt injection from PR contents.** A malicious PR could try to
   convince the model to exfiltrate the API key, contact arbitrary URLs,
   read other repos' files on the host, etc.
2. **Supply-chain compromise of the SDK.** A bad release of
   `@anthropic-ai/claude-agent-sdk` (or any of its transitive deps) could
   read whatever the worker process can read.

The worker process has the GitHub installation token, the Litestream
credentials, the SQLite file, and the seccomp profile. It must not be
where Claude executes.

## Decision

Every `ReviewRun` spawns a **dedicated, ephemeral Docker container**:

- `--read-only` rootfs; only `/tmp` and `/workspace` are writable (tmpfs).
- `--cap-drop=ALL` and `--security-opt=no-new-privileges`.
- Custom seccomp profile (`docker/seccomp-claude.json`) — default-deny
  with ~150 syscalls allowed (no `clone3` of new namespaces, no `ptrace`,
  no `mount`, no `kexec`).
- `--user=10001:10001` (non-root, no shell on PATH).
- `--network=gcr-egress` — a custom bridge with iptables rules that allow
  TCP/443 to `api.anthropic.com` IPs **only**. Everything else dropped.
- `--memory=4g --cpus=2 --pids-limit=256` to bound resource use.
- Anthropic API key mounted via tmpfs at `/etc/secrets/anthropic`. The
  container's entrypoint reads it once, `unlink`s it, then `exec`s the
  agent — so even a fork/exec inside the container can't re-read it.
- The GitHub token is **never** placed in the container. Cloning happens
  in the worker process; `.git` is stripped before the workspace is
  bind-mounted **read-only** into the container.
- Image is digest-pinned in production (`SANDBOX_IMAGE` env var).
- A reaper at worker startup kills any stale `gcr.run-id`-labeled
  containers; a periodic sweeper kills any older than 1 hour.

Stdout / stderr from the container are captured and run through the
secret redactor before being persisted.

## Alternatives considered

- **Run Claude in-process.** Tempting (one fewer hop). But the threat
  model puts the agent and the credentials in the same address space — a
  single buggy SDK release or successful prompt injection becomes a
  full-host compromise. No.
- **One long-lived sandbox container.** Re-uses memory but conflates two
  PRs' state — a successful injection in one persists into the next.
- **gVisor / Kata containers.** Stronger isolation. Adds an ops surface
  most operators don't want. Documented as a possible swap-in: the
  `SandboxRunner` interface is unchanged, only the `runtime` Docker option
  differs.
- **Firecracker microVMs.** Strongest isolation. Significant operational
  cost (KVM, qcow2 management). Revisit if a real customer has the
  threat model.
- **Run on a separate physical host.** The right answer at scale — the
  existing `Reviewer` port already supports it (the runner could RPC to a
  remote daemon). Out of scope for v1.

## Consequences

- Per-run cold-start cost (~1–2 s for image start + entrypoint). Acceptable
  given typical review wall-clock is minutes.
- Container reaper is required: orphaned containers are inevitable when
  the worker crashes mid-run.
- The egress firewall is host-side state (iptables on the bridge interface).
  Documented in `docker/network/README.md`. Replacing with an HTTP forward
  proxy is post-1.0 work.
- Operators must run the worker on a host with Docker available. (Or
  swap the runner — it's a port.)
- Anthropic API key is in the worker process's memory. We could remove
  this by having the sandbox fetch the key from a vault, but that adds an
  auth secret to the container, which is the thing we're trying to avoid.

## Reversal cost

Medium. The `Reviewer` port (ADR 0006) keeps the rest of the system
ignorant of "is this in a sandbox?" — swapping the runner for an
in-process implementation is a one-file change. Reversing the security
posture is a separate, deliberate decision.

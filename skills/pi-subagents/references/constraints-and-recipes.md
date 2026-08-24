# Pi Subagents: Constraints

This file is a detailed reference loaded from `skills/pi-subagents/SKILL.md`.
Read it after the parent has decided to delegate and wants to confirm the
always-on safety rules before launching or reviewing child work. Orchestration
recipes (Fable mode, Recon → Plan → Implement, review loop, parallel review,
parallel cleanup, staged fix orchestration, etc.) live in
`references/orchestration-recipes.md`; this file only covers constraints, best
practices, and error handling.

## Important Constraints

- **Explicit forking requires a persisted parent session.** If the current session
  does not have a persisted session file or current leaf, explicit `context: "fork"`
  fails. An agent-level `defaultContext: fork` is a preference: packaged `worker`,
  `oracle`, and `advisor` fall back to `fresh` when those fork preconditions are not
  met yet. Use `context: "fresh"` when you do not want a fork even after the parent
  session exists.
- **Forked runs inherit parent history.** They are branched threads, not fresh
  filtered contexts. Use fresh context for adversarial reviewers unless the user explicitly asks for forked context.
- **Default subagent nesting depth is 2.** Deeper recursive delegation is blocked
  unless configured otherwise.
- **Attention signals are not lifecycle state.** `needs_attention` means no activity has been observed past the configured threshold. `paused` means the child turn was intentionally interrupted or is awaiting direction; it is not the same as `failed`.
- **Intercom asks are blocking.** A session can only maintain one pending outbound
  ask wait state at a time.
- **Keep conversational authority clear.** Advisory subagents should not silently
  become second decision-makers.
- **Respect the fixed authority policy.** `authorityPolicy` is a small `auto` / `confirm` / `forbid` map for supported operational actions. Worktree discard, destructive cleanup, and spawn-budget grants default to confirmation; stop, steer, and schedule creation remain automatic. Use `worktree.discard` with the durable `handoffPath`; confirm-required actions refuse safely without an interactive UI and retained paths include manual Git recovery commands.

Runtime config can change orchestration behavior. `intercomBridge.resultDelivery: false` disables only external acknowledged grouped-result delivery when native parent notifications own completion; supervisor asks/progress stay active, and enabled transport failures are still reported. `asyncByDefault` and `forceTopLevelAsync` affect whether launches detach; `waitTool` can make direct `subagent_wait()` calls return immediately while headless auto-drain remains active, and its effective value is propagated to child runtimes; `globalConcurrencyLimit` bounds concurrent fanout, while a positive `maxSubagentSpawnsPerSession` optionally caps cumulative launches (`0` or unset is unlimited). Status and doctor report the budget; static work preflights declared capacity; only the settled root interactive parent can use `grant-spawn-budget` after native confirmation, with total grants bounded by the original cap. Compaction does not reset usage or grants; `singleRunOutputBaseDir` and `worktreeBaseDir` route outputs and worktrees; `completionBatch` groups async notifications. `artifactDir` is `session` (default), `project`, or `temp` and chooses where subagent artifacts are stored. Set `asyncWidget: false` to hide the above-editor background-run widget when a companion footer or dashboard owns that space (fleet inspector remains available). Per-run `artifacts: false` disables artifact capture for that launch. Async status and result artifacts include `lifecycleArtifactVersion` and fields such as `workflowGraph`, `steps`, `results`, `totalTokens`, `totalCost`, `turnCount`, `toolCount`, and nested `children`. Child protocol failures expose a structured `protocolError`; `protocol_output_limit` means a child emitted a JSONL line above the 16 MiB live-parser cap. Prefer these artifacts and `status` views over scraping terminal output.

### Keep report artifacts out of the repository root

Treat lane reports, review notes, council pass reports, and gate logs as scratch unless the user explicitly asks to keep them. Prefer `output: false` and the aggregate workflow result for short reports. When a later step needs a file, use the runtime-managed output artifact by setting a stable child key plus a relative `output` path such as `plans/deploy.md`; relative child outputs are saved under the run artifact directory, not the project root. Do not put `reports/...`, `*-report.json`, or similar repo-root paths in child task text.

For durable evidence, copy only the final summary to session memory, a PR body/comment, a mission artifact, or a user-approved docs path outside the repo. After the PR, issue, or gate reaches a terminal state, delete or move scratch reports from the active worktree before reporting completion. Keep a project `.gitignore` entry for ad-hoc report patterns only as a safety net; it is not the cleanup mechanism.

## Best Practices

### Prefer async orchestration

Launch every subagent asynchronously by default. Use `async: true` for scouts, researchers, workers, reviewers, validators, oracle checks, one-off delegates, and scripted workflows unless you intentionally need a foreground/blocking run. Launch all execution through `workflowScript`; use `return runs.run("main", { agent, task })` for one isolated child and `runs.all([...])` when two or more child lanes, monitors, or dependent steps should move together. The parent should keep moving: inspect code while scouts run, prepare validation while a worker implements, do a local diff pass while reviewers review, and synthesize or verify while a fix worker applies accepted feedback. Async is the default orchestration posture; foreground runs are the explicit opt-out.

### Use subagent_wait() to block until async runs finish

In an interactive chat, do not call `subagent_wait()` merely to wait after launching background work; return control to the user and Pi will wake the session on completion. Override that default when the current request is run-to-completion — for example, the user asked you to stay with the task and report results back this turn or a skill must finish in one turn. In a headless run, Pi auto-drains exact current-session work at `agent_end`; call `subagent_wait()` when this turn must receive results before it ends. In either case, `subagent_wait()` blocks the current turn until the next run completes or needs attention, keeps the turn alive for normal notification delivery, then returns.

- `subagent_wait()` — return when the next initially active async run or registered provider item finishes, or a subagent needs attention.
- `subagent_wait({ all: true })` — block until every async run and provider item active at call time finishes, or a subagent needs attention.
- `subagent_wait({ id: "..." })` — block on one async or remembered detached foreground run (id or prefix). Provider items are not selected through this parameter.
- `subagent_wait({ stopOnAttention: false })` — for blocking waits only, keep waiting through idle or long-thinking attention; supervisor/contact requests still stop the wait.
- `subagent_wait({ timeoutMs })` — cap the block; active work keeps running if it elapses.

Providers are discovered through the `pi-subagents/background-work` registry and must return stable item IDs with exact owning session IDs. Child agents receive no provider automatically: keep `subagent_wait` in the child `tools` allowlist and load provider extensions through `extensions` or `subagentOnlyExtensions`.

For non-interactive fleet orchestration, `subagent_wait()` can keep N workers in flight: launch N, wait for the next completion, react to the result, launch a replacement if needed, then wait again. Use `subagent_wait({ all: true })` only when you intentionally want to drain the fleet to zero. If the turn ends first, headless `agent_end` auto-drain still waits for exact current-session work. In an interactive session, return to the user instead of holding the turn open just to await completion.

If config or `PI_SUBAGENT_WAIT_TOOL_ENABLED` disables blocking behavior, direct `subagent_wait` calls return immediately. Headless `agent_end` auto-drain remains active as a lifecycle safeguard and surfaces provider, reconciliation, or timeout failures.

### Keep writes single-threaded by default

A strong pattern is one main decision-maker plus advisory/research/review/validation subagents around it. Use `oracle` for advice and `worker` for the actual write path. Parallelize reading, review, validation, and synthesis support, not normal writes, unless you deliberately isolate writers with worktrees. Across repositories, each repo/worktree still gets at most one writer, with explicit `cwd` and authority in the child prompt. A child that writes should report what changed, what was left undone, commands run with exit codes, validation evidence, surprises, and any decisions that need parent approval.

### Use fork for branched advisory or execution threads

Forked runs are useful when the child should reason in a separate thread while
still inheriting the parent's accumulated context. They are especially useful for
`oracle`, which audits inherited decisions and drift. For adversarial code review,
prefer fresh-context reviewers that inspect the repo and diff directly unless the
user explicitly requests forked context.

### Prefer narrow tasks

Give subagents specific tasks rather than vague mandates.
`Review auth.ts for null-check gaps` works better than `Review everything`.

Before fanout, assign each child a lightweight task profile in the parent prompt:
work kind, required input, expected output, acceptance check, and context mode.
Keep the profile prose-only; do not invent runtime fields. Use coarse kinds such
as `code-write`, `code-read`, `transform`, `summarize`, and `search` only to
shape the task and choose an existing agent/model setting. If a child task is not
standalone enough for fresh context, add the missing facts to the prompt, switch
to forked context, or ask the user. Do not launch vague tasks and rely on
supervisor round-trips to recover missing context.

### Escalate decisions upward

If a subagent encounters an unapproved product, architecture, scope, merge, release, credential, or authority choice, it should use `contact_supervisor` and wait for the reply instead of deciding alone. Generic `intercom` is external or provider-supplied only. Use it only when external bridge instructions provide an explicit safe target. External checks, receipts, and review bots provide evidence only; they do not grant authority.

### Use a short oracle consultation for material advice

When a user asks to ask, consult, discuss with, or come to agreement with `oracle` about a plan, design, or architecture decision, do not treat the first advisory report as final when it raises a material challenge or tradeoff. Read it, resume the same oracle session once with a targeted question, then make the parent decision. An explicit one-shot request, a trivial question, or a fully settled first answer does not need a follow-up.

### Intervene only on clear control signals

Use subagent control proactively when a delegated run emits `needs_attention`, or when a human asks you to regain control. Do not interrupt just because a child has briefly produced no output. Silence can be normal during long tool calls, test runs, or model reasoning.

### Name sessions meaningfully

Use `/name` so intercom targeting stays stable.

## Error Handling

**"Unknown agent"**
```typescript
subagent({ action: "list" })
// Check available agents, then confirm scope/precedence. Saved chains are not a
// public execution surface; author orchestration with workflowScript.
```

**Setup, discovery, or intercom confusion**
```typescript
subagent({ action: "doctor" })
// Check runtime paths, async support, discovery counts, current session, and intercom bridge state.
```

**"Max subagent depth exceeded"**
```typescript
// Flatten the workflow or raise maxSubagentDepth in config.
```

**"Session manager did not return a session file"**
```typescript
// Persist the current session before using context: "fork".
```

**Intercom "Already waiting for a reply"**
```typescript
// Resolve the current outbound ask before starting another one.
```

**Parallel output-path conflict**
```typescript
// Give each parallel task a distinct output path, or disable output for tasks that do not need it.
```

**Worktree launch fails**
```typescript
// Ensure the git working tree is clean and task cwd overrides match the shared cwd.
```

**Child fails before starting**
```typescript
// Inspect `subagent({ action: "status", id: "..." })`, artifact metadata/output logs, and run doctor. Extension loader errors usually appear in child output logs.
```

---
name: pi-subagents
description: |
  Delegate work to builtin or custom subagents with single-agent, parallel,
  scripted, compatibility-chain, async, forked-context, and coordinated workflows. Use
  for advisory review, implementation handoffs, and multi-step tasks where a
  single agent should stay in control while other agents contribute context,
  planning, or execution. Do not use for one ordinary read-only quick-scout or
  quick-review launch when the registered subagent tool description already
  provides that named-role contract; launch it directly from that contract.
---

# Pi Subagents

This skill is for the main parent orchestrator only. Do not inject or follow it inside spawned child subagents. The parent session owns delegation, orchestration, review fanout, and final fix-worker launches. Ordinary children should not run their own subagent workflows; the explicit exception is a delegated fanout child whose resolved builtin `tools` includes `subagent`, and that child may use `subagent` only for the fanout work the parent assigned.

Use this skill when the parent orchestrator needs one specialized child or composed orchestration. Use `workflowScript` for all execution, including one isolated child. Use `return runs.run("main", { agent, task })` for one child and `runs.all([...])` for coordinated waves: sequence, parallelism, branching, retries, gate monitors, and aggregation. Scripted workflows start asynchronously by default; pass `async:false` only for a small foreground run.

Exception: for one ordinary read-only `quick-scout` or `quick-review` launch,
follow the registered subagent tool description directly and do not load this
skill or its references. Load this skill when the role is unfamiliar, the
launch is customized, or the work requires fanout, retries, lifecycle control,
mutation, or broader orchestration.

## How to use this router

**Do not read the references below to decide whether to delegate.** That decision is made by the parent session from its own rules and the user's request, not by reading this skill. The agent catalog and orchestration recipes are only useful after the parent has decided to delegate work, and loading them earlier just to "check" wastes context for sessions that end up doing the work themselves.

Once the parent has decided to delegate, read the matching reference file before acting. Paths are relative to this `SKILL.md`; resolve them against `skills/pi-subagents/` and load them with the read tool.

| Task (after deciding to delegate) | Read |
| --- | --- |
| Choose an agent, write a custom prompt, override its model, or compare tool vs slash commands | `references/agent-catalog.md` |
| Pick an execution shape: one-child, scripted, async, scheduled, mission-backed, forked, watchdog, oracle, or intercom-coordinated | `references/execution-controls.md` |
| List/create/update/delete/eject/disable agents or chains, edit agent files, use prompt-template integration, or expose extension RPC | `references/management-authoring-rpc.md` |
| Apply an orchestration recipe (parallel review, review loop, parallel research, gather-then-clarify, parallel cleanup, staged fix orchestration, Fable mode, etc.) | `references/orchestration-recipes.md` |
| Check safety constraints, best practices, or error handling | `references/constraints-and-recipes.md` |

For broad or uncertain requests, read more than one reference. For complex work, start with `references/agent-catalog.md` and `references/execution-controls.md`, then consult `references/orchestration-recipes.md` and `references/constraints-and-recipes.md` before launching or reviewing child work.

## Always-on constraints

- Keep the parent as orchestrator and final decision-maker.
- Use one writer per cwd/worktree unless isolated worktrees are intentional.
- For cross-codebase work, record the target repo, explicit `cwd`, authority boundary, and expected output before launch. Do not assume the parent session cwd is the child repo.
- For parallel fanout, compare child prompts before launch. Do not send clone prompts with only issue numbers, titles, or broad file globs swapped; each child needs a lane-specific task, source seam, prior evidence, and decision that remains distinct without the item number. Launch that fanout as one async `workflowScript` with stable keys and aggregate output unless there is truly only one child.
- Prefer fresh-context review/validation fanout, then synthesize and apply fixes in the parent.
- Use async/background by default when work can proceed independently; do not poll just to wait. For adaptive gates, branch in `workflowScript`. Approval controls remain available only for already-running durable legacy chains.
- Preserve capability ceilings, including child tool restrictions and session-scoped allowed-agent restrictions.
- Escalate unresolved product, architecture, authority, release, merge, or safety decisions upward instead of letting a child decide silently.
- Treat receipts, CI, review bots, and external-run records as evidence, not authority to merge, close, comment, publish, or release.
- As a conservative orchestration policy, do not pass `turnBudget`, a hard `toolBudget`, or a tight `usageBudget` to mutation-capable workers. The default tool budget blocks read/search tools rather than mutation tools, and reported usage has no reservation model. If a worker is interrupted after a tool call starts, checkpoint after the current tool returns with changed files, build/test state, and commit or PR state.

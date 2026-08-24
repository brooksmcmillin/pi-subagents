---
name: pi-subagents
description: |
  Delegate work to builtin or custom subagents with single-agent, parallel,
  scripted-chaining, async, forked-context, and coordinated workflows. Use
  for advisory review, implementation handoffs, and multi-step tasks where a
  single agent should stay in control while other agents contribute context,
  planning, or execution. Do not use for one ordinary read-only quick-scout or
  quick-review launch when the registered subagent tool description already
  provides that named-role contract; launch it directly from that contract.
---

# Pi Subagents

This skill is for the main parent orchestrator only. Do not inject or follow it inside spawned child subagents. The parent session owns delegation, orchestration, review fanout, and final fix-worker launches. Ordinary children should not run their own subagent workflows; the explicit exception is a delegated fanout child whose resolved builtin `tools` includes `subagent`, and that child may use `subagent` only for the fanout work the parent assigned.

Use this skill when the parent orchestrator needs one specialized child or composed orchestration. Use `workflowScript` for all execution, including one isolated child. Chaining is still supported, but it is code-driven: use `await runs.run(...)` for sequential steps, `runs.all([...])` for parallel fanout, and ordinary JavaScript for branching, retries, gate monitors, and aggregation. Keep workflow helpers portable: use plain helper functions or explicit Promise chains, not nested `async function` helpers, async arrows, or async methods. Do not use legacy top-level `chain` / `tasks` inputs or durable `.chain.md` execution. Scripted workflows normally start asynchronously unless config sets `asyncByDefault:false`; set `async:true` explicitly when async behavior matters. Pass `async:false` only when the parent must block until completion. Async mode still shows progress. Do not use `async:false` for final reviews, backlog gates, run-to-completion convenience, or because no other work is available.

Package-installed agents appear in `subagent({ action: "list" })` with builtin, user, and project agents. If `surf-cli` is installed as a Pi package, the Surf browser extension is loaded, and Chrome is logged into a ChatGPT Pro account, Surf can expose `gpt-pro`: a read-only async advisor that reaches ChatGPT web through Surf Oracle. Check it with `subagent({ action: "get", agent: "gpt-pro" })` and run it with `subagent({ agent: "gpt-pro", task: "Review this plan and identify release risks." })`.

Exception: for one ordinary read-only `quick-scout` or `quick-review` launch, follow the registered subagent tool description directly and do not load this skill or its references. Load this skill when the role is unfamiliar, the launch is customized, or the work requires fanout, retries, lifecycle control, mutation, or broader orchestration.

## How to use this router

**Do not read the references below to decide whether to delegate.** That decision is made by the parent session from its own rules and the user's request, not by reading this skill. The agent catalog and orchestration recipes are only useful after the parent has decided to delegate work, and loading them earlier just to "check" wastes context for sessions that end up doing the work themselves.

Once the parent has decided to delegate, read the matching reference file before acting. Paths are relative to this `SKILL.md`; resolve them against `skills/pi-subagents/` and load them with the read tool.

| Task (after deciding to delegate) | Read |
| --- | --- |
| Choose an agent, write a custom prompt, override its model, or compare tool versus slash commands | `references/agent-catalog.md` |
| Use council mode, convene several advisors, debate a decision, cross-examine recommendations, critique or improve a plan with multiple model perspectives, or run `/council` | `../council-mode/SKILL.md` |
| Pick an execution shape: one-child, scripted, async, scheduled, mission-backed, forked, watchdog, oracle, or intercom-coordinated | `references/execution-controls.md` |
| Coordinate several independent tasks, worktrees, repositories, or writer lanes | `references/multi-lane-orchestration.md` |
| List/create/update/delete/eject/disable agents or chains, edit agent files, use prompt-template integration, or expose extension RPC | `references/management-authoring-rpc.md` |
| Apply an orchestration recipe such as parallel review, cleanup, staged fixes, or Fable mode | `references/orchestration-recipes.md` |
| Check safety constraints, best practices, or error handling | `references/constraints-and-recipes.md` |

For broad or uncertain requests, read more than one reference. For complex work, start with `references/agent-catalog.md` and `references/execution-controls.md`, then consult `references/orchestration-recipes.md` and `references/constraints-and-recipes.md` before launching or reviewing child work.

## Always-on constraints

- Keep the parent as orchestrator and final decision-maker.
- Before multiple mutation-capable lanes, record a lane board and each lane's isolation path.
- For plan, design, or architecture advice that asks for council mode, asks to convene several advisors, compare model perspectives, debate a decision, cross-examine recommendations, or critique and improve a plan, read `../council-mode/SKILL.md` and use Council Mode instead of ad hoc parallel oracle calls.
- For plan, design, or architecture advice that asks to consult, discuss with, or come to agreement with one `oracle`, use a short same-session consultation loop: read the first result, resume once with a targeted challenge when material tradeoffs remain, then synthesize the parent decision. Keep explicit one-shot, trivial, and fully settled consultations one-shot.
- Use one writer per cwd/worktree unless isolated worktrees are intentional.
- For cross-codebase work, record the target repo, explicit `cwd`, authority boundary, and expected output before launch. Do not assume the parent session cwd is the child repo.
- For parallel fanout, compare child prompts before launch. Do not send clone prompts with only issue numbers, titles, or broad file globs swapped; each child needs a lane-specific task, source seam, prior evidence, and decision that remains distinct without the item number. Launch that fanout as one async `workflowScript` with stable keys and aggregate output unless there is truly only one child.
- Prefer fresh-context review/validation fanout, then synthesize and apply fixes in the parent.
- Use async/background by default. Final reviews, gate checks, oracle checks, and backlog lanes stay async. Use `async:false` only when the parent must block until completion. Do not poll just to wait. For adaptive gates, branch in `workflowScript`.
- For Pi extension repos whose canonical checkout is under `~/.pi/agent/extensions`, never create lane worktrees as sibling directories there. Pi auto-loads `~/.pi/agent/extensions/*/index.ts`, so sibling worktrees can register duplicate tools. Put lanes under `~/.pi/agent/worktrees`, another worktree base outside auto-discovery, or a temporary clone. If a lane must run the modified extension itself, use an isolated Pi config home with `PI_CODING_AGENT_DIR=<lane-config> pi --no-extensions -e <lane>/index.ts`. Use full containers only when path and config isolation are insufficient.
- Preserve capability ceilings, including child tool restrictions and session-scoped allowed-agent restrictions.
- Escalate unresolved product, architecture, authority, release, merge, or safety decisions upward instead of letting a child decide silently.
- Treat receipts, CI, review bots, and external-run records as evidence, not authority to merge, close, comment, publish, or release.
- As a conservative orchestration policy, do not pass `turnBudget`, a hard `toolBudget`, or a tight `usageBudget` to mutation-capable workers. The default tool budget blocks read/search tools rather than mutation tools, and reported usage has no reservation model. If a worker is interrupted after a tool call starts, checkpoint after the current tool returns with changed files, build/test state, and commit or PR state.

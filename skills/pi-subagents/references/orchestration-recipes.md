# Pi Subagents: Orchestration Recipes

This file is a detailed reference loaded from `skills/pi-subagents/SKILL.md`.
Read it only after the parent has decided to delegate work and wants to apply a
specific orchestration pattern. The recipes below are useful for actual
delegation; loading them just to "check what's available" wastes context for
sessions that handle the work themselves.

The prompt templates in `prompts/` encode the same patterns the parent can run on demand. If the user provides a URL, issue, PR, plan, local file, screenshot, or freeform target, treat that target as the primary scope: read or fetch it before launching children, then include it explicitly in every child task. For targets outside the parent cwd, include the exact repository, explicit `cwd`, authority boundary, and expected output path in each child task. Do not depend on the parent conversation history when the recipe calls for fresh context.

## Parallel review technique

Use this when the user wants adversarial review of a diff, plan, issue, file, or implemented work. Launch fresh-context `reviewer` agents with distinct angles generated from the actual target. Common angles are correctness/regressions, tests/validation, and simplicity/maintainability; adapt for TypeScript, UI, security, docs, or large structural changes. Reviewers should inspect files and diffs directly, return concise evidence-backed findings with file/line references, and avoid edits unless the user explicitly asks for a writer pass. The parent synthesizes fixes worth doing now, optional improvements, and feedback to ignore/defer before applying anything.

## Proactive skill-specialist technique

Use this when `{ action: "list" }` reports proactive skill subagent suggestions and the user's task would benefit from perspectives the parent regularly uses. These suggestions are conservative: a skill is recommended only when it is available and referenced repeatedly by configured agents or saved chains. Treat the list as an opt-in hint for the current task, not a command to always fan out.

Default guardrails:
- Keep the fanout small: usually one or two skill-specialist children, never more than the listed recommendations or configured cap.
- Prefer `context: "fresh"` and include only the files, diff, plan, URL, or request details each child needs. Use forked context only when private/session history is essential and appropriate to share.
- Use read-only agents for analysis/review unless implementation was explicitly requested; do not create several writers in the same worktree.
- Skip proactive skill subagents for tiny questions, direct commands, highly private requests, or when the user asks not to delegate.
- Make cost and concurrency visible by using an ordinary `subagent(...)` call rather than hidden/background automation.

Example shape:

```typescript
subagent({
  workflowScript: `
    const results = await runs.all([
      { key: "deslop", agent: "reviewer", task: "Apply the available 'deslop' skill to review the current diff for concrete cleanup findings only. Do not modify files.", skill: "deslop" },
      { key: "accessibility", agent: "reviewer", task: "Apply the available 'accessibility' skill to review the UI changes for concrete issues only. Do not modify files.", skill: "accessibility" }
    ]);
    return results.map(result => result.output);
  `,
  context: "fresh"
})
```

## Review-loop technique

Use this when the user wants implementation or current diff review to continue until reviewers stop finding fixes worth doing now. Keep the loop in the parent session: one async `worker` implements or fixes, fresh-context `reviewer` agents inspect the actual repo and diff, the parent synthesizes accepted fixes, and one async forked `worker` applies them. The parent can express the sequence up front as an async/background `workflowScript` when the workflow is known, or continue with explicit follow-up workflowScript runs after each async completion. For an initial workflow, pass `async: true` so the main chat is unblocked. Treat an async implementation worker handoff as an intermediate state, not final completion, unless the user explicitly asked for worker-only work, review-only output, or to stop after implementation. Stop when reviewers find no blockers or fixes worth doing now, remaining feedback is optional or deferred, an unapproved product/scope/architecture decision appears, or the max review-round cap is reached. Default to 3 review rounds unless the user sets a different cap. Do not loop for optional polish, and do not let children launch subagents or decide the loop outcome.

As a conservative orchestration policy, do not pass `turnBudget` or a hard `toolBudget` to an implementation worker, fix worker, reviewer with edit authority, or other mutation-capable child. The default tool budget blocks read/search tools rather than mutation tools, but count limits still do not measure delivery safety. Use a narrow task plus an outer elapsed deadline with enough margin, then request a checkpoint after the current tool returns. The checkpoint should report changed files, build/test state, remaining work, and commit or PR state. An elapsed timeout is not a mutation-safe boundary and must not be used as the checkpoint trigger.

## Parallel research technique

Use this when the question needs both external evidence and local implications. Combine `researcher` for official docs, specs, ecosystem behavior, recent changes, benchmarks, and primary sources with `scout` for repository files, patterns, constraints, tests, and likely integration points. Give each child a distinct angle: external evidence, local code context, and practical tradeoffs. Ask for source links or file ranges, confidence level, gaps, and decision implications. Do not ask these children to edit unless implementation was explicitly requested.

## Gather-context-and-clarify technique

Use this at the start of non-trivial work. Launch `scout` for local context and `researcher` only when external docs, recent sources, ecosystem context, or primary evidence would materially improve understanding. Ask children for concise findings plus remaining clarification questions. Then synthesize what is known and use `interview` to ask the unresolved questions needed for shared understanding before planning or implementing.

## Parallel cleanup technique

Use this after implementation when the user wants cleanup review or when a final pass would reduce AI-slop. Launch two fresh-context `reviewer` tasks with `output: false` and `progress: false`: one deslop pass and one verbosity pass. If the `deslop` or `verbosity-cleaner` skills are available, pass the relevant skill to that reviewer; otherwise inline the criteria. Both reviewers are review-only and should flag concrete issues with severity, file/line references, and smallest safe fixes. Phrase the constraint as "Do not modify project/source files; returning findings through the configured output artifact is allowed" when you use `output` or `outputMode: "file-only"`. The parent decides what to apply and asks before making changes unless cleanup was already authorized.

## Staged fix orchestration technique

Use this when a broad diff has known reviewer findings across several items and the user wants the parent to "orchestrate subagents like a boss." Keep the active worktree safe with a three-stage chain:

1. A parallel read-only planning fanout, one reviewer per issue cluster. Each child inspects the real diff and returns exact files, line refs, proposed fixes, and focused validation. They must not edit.
2. One writer worker. It receives the reviewer summaries through `{previous}`, the parent's accepted scope, stop rules, and verification contract. It is the only child allowed to edit the active worktree.
3. A parallel read-only validation fanout. Validators inspect the worker diff from fresh context with distinct angles, report pass/fail, remaining blockers, and missing verification.

Prefer `async: true`, `context: "fresh"` for reviewers/validators, `outputMode: "file-only"` for large summaries, and per-stage output names that will not collide. Add `phase` and `label` to make async status readable, and use `as` plus `{outputs.name}` when a later step needs a specific earlier result instead of the whole `{previous}` blob. Use this pattern instead of launching several writer workers into a dirty worktree. Include non-blocking suggestions in the writer prompt only when they are small, safe, and do not expand product scope; otherwise record them as deferred.

When one child returns a structured target list, use ordinary JavaScript to validate/filter it and map bounded entries into `runs.all`; do not use the removed chain fanout DSL.

Example shape:

```typescript
subagent({
  async: true,
  context: "fresh",
  chain: [
    { parallel: [
      { agent: "reviewer", phase: "Planning", label: "Deploy docs", as: "deployPlan", task: "Plan fixes for deploy docs/workflow. Inspect the current diff. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "plans/deploy.md", outputMode: "file-only" },
      { agent: "reviewer", phase: "Planning", label: "Scheduler contract", as: "schedulerPlan", task: "Plan fixes for scheduler contract. Inspect the current diff. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "plans/scheduler.md", outputMode: "file-only" },
      { agent: "reviewer", phase: "Planning", label: "Sandbox/security", as: "sandboxPlan", task: "Plan fixes for sandbox/security. Inspect the current diff. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "plans/sandbox.md", outputMode: "file-only" }
    ], concurrency: 3 },
    { agent: "worker", phase: "Implementation", label: "Apply accepted fixes", as: "workerResult", task: "Apply only the accepted fixes from these planning summaries. You are the sole writer for the active worktree. Run focused validation and report changed files, commands, failures, and remaining issues.\n\nDeploy plan:\n{outputs.deployPlan}\n\nScheduler plan:\n{outputs.schedulerPlan}\n\nSandbox plan:\n{outputs.sandboxPlan}", output: "worker/fixes.md", outputMode: "file-only", progress: true },
    { parallel: [
      { agent: "reviewer", phase: "Validation", label: "Deploy/scheduler validation", task: "Validate the post-worker diff for deploy and scheduler fixes. Start from the worker result: {outputs.workerResult}. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "validation/deploy-scheduler.md", outputMode: "file-only" },
      { agent: "reviewer", phase: "Validation", label: "Sandbox validation", task: "Validate the post-worker diff for sandbox/security fixes. Start from the worker result: {outputs.workerResult}. Do not modify project/source files; returning findings via the configured output artifact is allowed.", output: "validation/sandbox.md", outputMode: "file-only" }
    ], concurrency: 2 }
  ]
})
```

## Recon → Plan → Implement

```js
subagent({ workflowScript: `
  const context = await runs.run("recon", { agent: "scout", task: "Inspect the codebase and identify the implementation seam" });
  return (await runs.run("implement", { agent: "worker", task: "Implement from: " + context.output })).output;
` })
```

## Fable mode for complex work

Fable mode is the default orchestration posture for complex work. It is not a separate runtime mode; it is how the parent session uses `subagent`, `interview`, `subagent_wait`, acceptance contracts, artifacts, and fresh-context review when the work has real complexity. Use it for complex features, broad refactors, migrations, ambiguous goals, multi-system changes, expensive validation, user-visible behavior changes, or any request to plan/orchestrate end to end. Do not force it onto tiny one-shot delegation.

Run the work through seven gated phases:

1. **Understand** — use `scout` fanout for breadth, but the parent personally reads the load-bearing files and lets direct source reading decide disagreements. Gate: the parent can quote the exact code or behavior being changed and knows the repo's verification harness.
2. **Decide** — separate user-owned decisions from implementation judgments. Use `interview` for product, naming, cost, taste, risk, release, merge, or authority decisions; decide routine engineering details in the parent and state them. Gate: every user-owned decision needed for design is answered or recorded as a blocked follow-up.
3. **Design** — use read-only design/review children for parallel perspectives. Before parallel workstreams, write seam contracts: ownership boundaries, composition points, assumptions, and validation handoffs. Gate: one parent-synthesized plan and written seams for parallel work.
4. **Implement** — capture a baseline first, then launch one async `worker` as the sole writer for the active worktree unless isolated worktrees were intentionally requested. For cross-codebase work, launch separate async workers only when each has its own repo/worktree, explicit `cwd`, and non-overlapping authority. Break large work into serial milestones instead of concurrent writes. Gate: build/typecheck is green and every output or diff delta is characterized as intended or fixed.
5. **Verify** — climb the spend ladder: static checks, free end-to-end/dry-run, cheapest live probe, targeted changed-path live test, then full realistic run when warranted. Observe the artifact itself, not only exit codes or scores, and confirm the changed code actually executed. Gate: the highest necessary rung has directly observed evidence matching intent.
6. **Iterate** — when a gate or reviewer finds a defect, the parent names the failure class, searches for siblings, synthesizes fixes, and sends exactly one fix worker for accepted changes. For LLM judges, gates, or detectors, trigger on concrete findings rather than scores, record pass/violations/error verdicts, cache nondeterministic verdicts by input hash, budget enough output tokens, and sanitize judge text before reusing it downstream. Gate: the class is fixed or explicitly bounded, and recurrence detection exists when feasible.
7. **Ship** — run adversarial fresh-context review/validation outside the implementation path, disposition every finding, rerun affected gates, then have the parent inspect the final diff. Commit, push, comment, close, merge, release, or open PRs only inside user-approved boundaries for that repo. Gate: findings are dispositioned, gates re-pass, and the final summary names evidence, artifacts, residual risks, and output paths.

## Clarify → Plan → Implement → Review (self-orchestrated workflow)

For straightforward non-trivial work, this sequence is the lightweight version of the parent-owned loop. When the task is complex, use Fable mode above. In either case, factor in the packaged prompt workflows without literally invoking slash commands. Use the same patterns through tools and subagents.

Keep builtin agent defaults unless the user explicitly asks for a different model, thinking level, skills, output behavior, context mode, or other override. Do not add overrides just because you are orchestrating; the defaults encode the intended role behavior. In particular, packaged `worker`, `oracle`, and `advisor` default to forked context.

When the user approves launching a subagent to carry out a plan or workflow, treat that as approval to generate a proper role-specific meta prompt for that subagent. Include the approved plan path or summary, clarified requirements, non-goals, relevant context, role boundaries, files or areas to inspect, acceptance criteria, expected output, and validation expectations. Do not pass vague instructions like "implement the plan fully" or "review this" by themselves.

- `/gather-context-and-clarify` maps to: launch `scout` and, when needed, `researcher`; synthesize findings; then use `interview` to ask every clarification question needed for shared understanding.
- `/parallel-review` maps to: launch fresh-context `reviewer` agents with distinct review angles; synthesize the feedback before applying anything.
- `/review-loop` maps to: keep the parent in charge of worker → fresh reviewers → synthesized fix worker cycles until no fixes worth doing now remain, an unapproved decision appears, or the review-round cap is reached.
- `/parallel-research` maps to: combine local `scout` context with external `researcher` evidence when current docs, ecosystem behavior, or API details matter.
- `/parallel-cleanup` maps to: use review-only cleanup passes after implementation, especially for simplicity, verbosity, and redundant tests.

For feature work, use this sequence as scaffolding for parent-agent behavior:

```text
clarify → validation contract → scout → async worker → parallel async fresh-context reviewers/validators → async fix worker → follow-up review when warranted → parent review
```

The validation contract defines acceptance before code is written: expected behavior, acceptance checks, commands or user flows to exercise, and evidence the worker should return. Keep it lightweight for small tasks, but make it explicit enough that reviewers and validators are checking the intended outcome rather than the worker's own assumptions.

For one host-run verification command, `gate: "npm test"` on the child is shorthand for verified acceptance with that command; it cannot be combined with `acceptance` and is rejected on retained resume items. Use the structured `acceptance` field when the run should carry an explicit acceptance contract. If omitted, subagents infer an effective policy from role, mode, and risk. Evidence levels end at `verified`: use `level: "checked"` for ordinary writer evidence and `level: "verified"` when the runtime should run explicit validation commands. Independent review is orthogonal; use `review: { required: true, agent: "reviewer" }` and orchestrate the reviewer separately. `review-required` means evidence passed but review is pending, while `reviewed` means a real independent result found no blockers. For reviewer/read-only calls, omit `acceptance`. Never explicitly request `level: "reviewed"`; that value remains recognized only so preflight can return an actionable correction. To disable gates, use `{ level: "none", reason: "..." }`; the bare string `"none"` is rejected, and `false` is accepted only as a deprecated shorthand. Child-reported command success is evidence, not runtime verification.

The first `worker` implements the approved plan. The parent continues with independent inspection or validation prep while it runs, not parallel edits to the same worktree. When the async worker completes, treat its handoff as the transition into review, not as final completion, unless the user explicitly asked for worker-only work, review-only output, or to stop after implementation. Parallel reviewers inspect the resulting diff from fresh context. Validators check behavior with the best available evidence: commands, tests, browser/CLI interaction, screenshots, logs, or manual reproduction notes. The final `worker` applies synthesized review fixes in forked context, then the parent looks over the final diff before completing. The parent may launch these steps as an initial async `workflowScript` when the workflow is already clear, or as follow-up workflowScript runs after each async completion. Initial workflows should pass `async: true` so the main chat is unblocked. Do not stop after parallel review unless the user explicitly asked for review-only output or the review surfaced a decision that needs approval first.

For complex work, risky changes, broad refactors, or many changed lines, increase review and validation fanout rather than trusting one reviewer. Use distinct angles such as correctness/regressions, tests/validation, simplicity/maintainability, security/privacy, performance, docs/API contracts, and user-flow behavior. When reviewers find non-trivial issues or the fix worker touches many lines, run another focused review round before final validation.

When review has already produced concrete findings across several independent areas, use staged fix orchestration: parallel read-only reviewers for each issue cluster, one sole writer worker for the active worktree, then parallel fresh-context validators. This is the safest way to handle a dirty worktree with many prior changes because it parallelizes judgment without parallelizing writes. Non-blocking suggestions may go into the writer prompt only if they are small, safe, and inside the approved scope; otherwise defer them explicitly.

For very large work, split into serial milestones instead of launching a swarm of writers. Each milestone gets one writer, a validation contract, fresh-context review/validation, a fix pass, and parent acceptance before the next milestone starts. Use parallel subagents inside a milestone for read-only context, research, review, and validation only.

Keep orchestration authority in the parent session. Child subagents should not launch more subagents, read this skill, or run their own orchestration loops unless the parent intentionally selected a fanout agent whose builtin `tools` includes `subagent`. Spawned subagents do not receive the `pi-subagents` skill, parent-only status/control/slash messages, or prior parent `subagent` tool-call/tool-result artifacts. Ordinary children also do not receive the `subagent` extension tool. Child context filtering strips old hidden orchestration-instruction messages when they appear in inherited history. Every child receives a boundary instruction: ordinary children are told the parent owns orchestration and they must not propose or run subagents; explicit fanout children are told to use `subagent` only for the assigned fanout work, with `maxSubagentDepth` still enforced. Implementation children must call real edit/write tools instead of printing pseudo tool calls. Pass children concrete role-specific work instead.

1. Clarify first. This is mandatory. Gather code context with `scout`, add `researcher` only when external evidence matters, then ask the user clarifying questions with `interview` until scope, acceptance criteria, constraints, and non-goals are clear.
2. Define the validation contract. State acceptance before implementation: expected behavior, checks to run, user flows to exercise, and evidence required in the worker handoff. For UI, CLI, integration, or workflow changes, include at least one validator angle that uses the product the way a user would rather than only reading code.
3. Plan when useful. For complex work, write a plan doc yourself and get approval before implementation. For simple work, confirm shared understanding and explicitly note why planning is skipped.
4. Implement with one writer. After approval, launch `worker` asynchronously with a proper meta prompt that includes clarified requirements, relevant context, plan path or summary, the validation contract, and output expectations. Packaged `worker` defaults to forked context; pass `context: "fresh"` only when you intentionally want a fresh child. While it runs, prepare validation or inspect adjacent code instead of editing the same worktree.
5. Require a useful worker handoff. Ask the worker to report changed files, what was implemented, what was left undone, commands run with exit codes, validation evidence, surprises or new risks, decisions made inside approved scope, and decisions needing parent approval.
6. Review after implementation. After the worker completes, launch parallel async fresh-context `reviewer` agents for correctness/regressions, tests/validation, and simplicity/maintainability. Add security, performance, docs/API, domain-specific, or user-flow validators for complex work, risky changes, broad refactors, or many changed lines. Use `output: false` unless review artifacts are explicitly needed.
7. Synthesize, then run the fix worker. Separate blockers, fixes worth doing now, optional improvements, and feedback to ignore/defer, then launch an async forked `worker` to apply fixes worth doing now when the workflow is implementation-authorized. If reviewers found scope/product/architecture choices that were not approved, ask the user first instead of applying them.
8. Review again when warranted. If the fix worker made substantial changes or addressed non-trivial findings, run another focused parallel review round before final validation.
9. Validate and complete. After the fix worker and any follow-up review return, inspect the final diff yourself, run or confirm focused validation, update docs/changelog when relevant, and summarize what changed and why.

Example implementation handoff after clarification and optional planning:

```typescript
subagent({
  workflowScript: `return runs.run("implementation", {
    agent: "worker",
    task: "Implement the approved feature.\n\nClarified requirements:\n- ...\n\nPlan: see ~/Documents/docs/...-plan.md\n\nValidation contract:\n- ...\n\nReturn a handoff with changed files, what was implemented, what was left undone, commands run with exit codes, validation evidence, surprises/new risks, and decisions needing parent approval.",
    acceptance: {
      level: "checked",
      evidence: ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"]
    }
  })`,
  async: true
})
```

Example review pass after implementation:

```typescript
subagent({
  workflowScript: `
    const results = await runs.all([
      { key: "correctness", agent: "reviewer", task: "Review the current diff for correctness and regressions. Inspect changed files directly; do not rely on the worker's reasoning.", output: false },
      { key: "tests", agent: "reviewer", task: "Review the current diff for tests and validation quality against the validation contract. Inspect changed files directly.", output: false },
      { key: "simplicity", agent: "reviewer", task: "Review the current diff for simplicity and maintainability. Inspect changed files directly.", output: false }
    ]);
    return results.map(result => result.output);
  `,
  context: "fresh",
  async: true
})
```

Example fix worker after parallel reviews:

```typescript
subagent({
  workflowScript: `return runs.run("fix", {
    agent: "worker",
    task: "Apply the synthesized reviewer feedback below. Only apply fixes worth doing now; preserve user-approved scope; ask before unapproved product or architecture changes. Run focused validation and summarize what changed.\n\nReviewer synthesis:\n..."
  })`,
  async: true
})
```

## Review loop

Do not treat review as the final step for implementation work. Run reviewers and validators, synthesize their findings against user scope and the validation contract, then launch one `worker` for accepted fixes when implementation is authorized.

When an async implementation worker completes, treat the worker handoff as an intermediate state. The next parent action is review fanout, then synthesis, then a fix worker if reviewers found fixes worth doing now. This can be planned as an initial async `workflowScript` when the whole workflow is known, or continued as follow-up workflowScript runs when the parent only launched the first worker initially. Initial workflows should pass `async: true` so the main chat is unblocked.

For explicit review-loop requests, repeat worker → fresh-reviewer → synthesized-fix-worker cycles until reviewers find no blockers or fixes worth doing now, remaining feedback is optional or intentionally deferred, an unapproved product/scope/architecture decision needs the user, or the max review-round cap is reached. Default to 3 review rounds unless the user sets a different cap. For complex work, many changed lines, or any fix pass that materially changes the diff, run another focused review round before the parent's final look; otherwise stop instead of chasing optional polish.

## Parallel non-conflicting analysis

```js
subagent({ workflowScript: `
  return await runs.all([
    { key: "frontend", agent: "scout", task: "Inspect the frontend" },
    { key: "backend", agent: "scout", task: "Inspect the backend" }
  ]);
` })
```

Use distinct keys, prompts, and output paths. Do not launch parallel writers into the same checkout.

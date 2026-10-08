# Compact task delivery

Use with `../SKILL.md` for an operator-authorized, single-seam task in one
verified workspace: bounded implementation, validation, and review. This is a
reading route through existing primitives, not a new runner or permission grant.
For ordinary delivery, these two files suffice; do not recursively load linked
references. Read an advanced branch below only when its trigger applies, before
using that capability. User/project instructions and required domain policies
still apply in full, including stricter review or publication gates.

## Before launch

- Confirm delegation authority from the operator or applicable instructions.
  Otherwise work directly. Parent owns scope, decisions, acceptance and
  publication; child success, CI and receipts are evidence, never authority.
- Record objective/acceptance, repository, canonical cwd, Git root/common-dir,
  branch/base/head, existing diff, task/run ownership, allowed files/actions,
  validation, handoff and next gate. Verify registration/ownership when using a
  linked worktree. Preserve unrelated work; uncertain or foreign ownership blocks
  mutation, not permission to take over. Follow local task/worktree provisioning
  rules; never copy whole `.pi` directories or grant agent approvals implicitly.
- Classify substantial mutation as single-seam or multi-seam, with evidence.
  Multiple independent contracts require the multi-lane branch before launch;
  do not split tightly coupled work artificially. Use isolation when overlap or
  concurrency matters. Keep extension worktrees outside auto-discovery paths.
- Keep **one writer per canonical cwd/worktree**, including parent, fix workers
  and commands generating files. Confirm the old writer terminal and preserve
  its partial diff/handoff before transferring ownership. Read-only review needs
  a quiescent, pinned candidate, not a moving diff.
- Discover `subagent({ action: "list", capabilities: true, cwd: CWD })`; launch
  with that same explicit cwd/scope. Re-list after provisioning or cwd changes.
  An unavailable role is not permission to switch to a primary checkout.
- Give each child a cold-start packet: objective and acceptance; repo/cwd/ref;
  exclusive edit/authority boundary; relevant files, contracts and constraints;
  focused validation; expected evidence/output; stop/ask conditions. No nested
  delegation, publication, merge, deployment or task-status mutation unless
  specifically delegated within the parent's authority. Preserve tool and
  allowed-agent capability ceilings. Keep model choice in deployment policy.

## Execute the smallest loop

Use direct `{ agent, task, cwd, async: true }` for one bounded child. Use one
async workflow per coordinated wave when keys or sequence matter. Set short
verb/behavior labels and stable keys independently. For the example below, the
parent supplies approved `args.cwd`, `args.writerPacket` and `args.reviewPacket`
containing the full contracts above; substitute discovered role names as needed.
The writer must report changed files, immutable candidate identity (commit or
staged-tree plus diff identity), validation commands/results, and open blockers.
The reviewer must verify that identity before inspecting files, report a mismatch
as blocked, and independently inspect evidence rather than trust writer prose.

```js workflow
const writer = await runs.run("delivery-write", {
  label: "Implement approved change", agent: "worker", cwd: args.cwd,
  context: "fresh", task: args.writerPacket,
  output: "delivery/writer.md"
});
const review = await runs.run("delivery-review", {
  label: "Review candidate change", agent: "reviewer", cwd: args.cwd,
  context: "fresh",
  task: args.reviewPacket + "\nWriter evidence (verify independently):\n" + writer.output,
  output: "delivery/review.md"
});
return { stage: "parent-disposition", writer, review };
```

Write the block and call `subagent({ workflow: true, async: true, cwd: CWD,
args: { cwd: CWD, writerPacket: WRITER_PACKET, reviewPacket: REVIEW_PACKET } })`
in the same reply. Omit child `async` so `await runs.run` observes completion,
not a dispatch receipt. A failed child rejects the awaited call and stops the
sequence before review. Relative `output` paths bind reports under run artifacts,
not the repository; filenames in task prose do not bind outputs. Inspect returned
run IDs and output references; a successful review run may still report blockers.
Keep normal automatic mission persistence; reuse its ID for follow-up work.

No extra scout, oracle, council, or reviewer fanout is required by this recipe.
Independent review is required when the operator/project contract calls for it;
otherwise parent inspection is valid. Do not apply hard tool budgets or tight
usage budgets to mutation workers. If interrupted, checkpoint after the current
tool returns with diff, validation and commit/PR state; a timeout is not a safe
mutation boundary.

During native async work, continue only safe independent work. If none remains,
record the completion wake trigger and yield. Do not poll, sleep, switch to
foreground or call `bg_wait` merely to await native completion notifications.
Answer `contact_supervisor(reason: "need_decision")` via `subagent_supervisor`
only within existing authority; escalate missing authorization, credentials or
consequential scope/product/architecture choices to the operator. A timeout is
not consent. If supervisor tools are unavailable, require a blocked handoff.

## Evidence, recovery and delivery

1. Parent inspects the actual candidate diff and validation evidence. Required
   checks must cover changed behavior; missing, failed or unavailable checks are
   blockers, never passes. Preserve commands, results and candidate identity.
2. Disposition each review finding: valid/fix now, valid/deferred, stale, invalid,
   speculative, or outside authority/scope. Cite evidence; do not blindly apply
   suggestions. Send accepted fixes only to the sole writer, rerun affected
   validation and required fresh delta review. Bound review rounds (default 3),
   then report unresolved findings. A review report is not merge permission.
3. For a failing gate, verify exact candidate/head, inspect focused logs, name the
   failed assertion/contract and distinguish current diff, stale test, setup or
   proven flake. Reproduce narrowly; fix forward and re-run affected checks.
4. Workflow/launch/runtime/extension/tooling failures are infrastructure blockers.
   Preserve exact error, run/status, repo/cwd/branch/ref and clean-state proof or
   partial diff. Use only a clear same-protocol retry within existing authority;
   execution-mode fallback (foreground, shell/CLI, another model) needs owner
   approval. Quiet/needs-attention is not terminal proof. Do not replace a live
   writer. Read the recovery branch for resume eligibility and latest run IDs.
5. A report-format mismatch can be normalized in the parent if supported source
   artifacts retain all required evidence; retain the original and uncertainty.
   Otherwise request only missing evidence using the supported schema. Never
   rewrite a failed run as successful or bypass an acceptance gate.
6. After compaction, recover durable task/mission/run records and current Git/PR
   identities before relaunching. Missing records mean unknown, not stopped.
7. Parent inspects final diff and performs only authorized publication using
   applicable user/project policy. Verify destination and actual push remote;
   required infrastructure precedes dependent code. Record exact published head
   and required CI separately from local validation/review; re-read head before
   accepting CI and invalidate readiness after any push. Pending, stale, missing,
   skipped-required or inaccessible checks are not green. Unknown requirements
   are not an empty requirement set. Required full audits are not replaced by a
   routine reviewer. No merge, deployment or cleanup authority is implied.
8. Handoff with changed files, validation, review dispositions, PR/head/CI where
   applicable, residual risks and next action. Respect the actual delivery
   endpoint: an open required PR is under review, not merged/completed. Non-PR
   work needs its actual acceptance evidence, not fabricated PR gates. Retain
   worktrees/artifacts until handoff is durable, no live run owns them and no later
   gate needs them; cleanup additionally requires its own authority and checks.

## Load only the triggered branch

Paths below are relative to this file. Read the named section first; load more
only for a concrete missing contract. Do not treat this table as a reading list.

| Trigger | Reference / section |
| --- | --- |
| Multiple tasks, repositories, independently testable seams, overlapping owners, writer waves or managed isolation | [Multi-lane orchestration](multi-lane-orchestration.md); for managed allocation also [Worktree isolation](../../../docs/workflows.md#worktree-isolation) |
| Custom roles, model tiers, unfamiliar prompt design | [Prompting and roles](prompting-and-roles.md) |
| Resume/replacement, setup failure, report mismatch, non-native wait, fork or external runner | [Execution controls](execution-controls.md): relevant recovery, retained-child, async, fork or external-profile section |
| Review fanout, disputed findings or unresolved gate failure | [Review and validation](review-and-validation.md) |
| New API field, typed gates/output schema, runtime acceptance or disabled workflow scripts | [Tool reference](../../../docs/tool-reference.md), [Workflows](../../../docs/workflows.md) or [Configuration](../../../docs/configuration.md), matching section only |
| Mission changes/recovery, schedules, watchdog, oracle or intercom | [Execution controls](execution-controls.md), matching section; schedules require explicit authorization |
| Capability/config constraints, budget grants or destructive discard | [Constraints](constraints-and-recipes.md); confirmation policy is not waived |
| Agent authoring/management or RPC | [Management, authoring and RPC](management-authoring-rpc.md) |
| Council explicitly requested | [Council skill](../../council-mode/SKILL.md) |
| Full PR audit, release, merge, backlog or deployment policy | Matching user/project prompt or skill; preserve all mandatory gates |

## Offline verification

Run `node --experimental-strip-types --test test/unit/task-delivery-guidance.test.ts`
from the package root. It replays this exact example through the existing workflow
sandbox with fake child results, tests failure short-circuiting and checks the
reading route and safety contracts. It measures `SKILL.md` plus this recipe against
the approximately 149,000-character observed reference baseline. This proves
script composition and prose contracts, not live model compliance, child safety
enforcement or end-to-end publication. No paid model calls are made.

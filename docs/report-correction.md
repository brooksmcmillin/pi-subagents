# Retained-evidence review report correction

Use the parent-only `report.correct` management action when a local native read-only
reviewer inspected the subject but ended with a rejected structured submission or
an accepted `status: "blocked"` report whose explanation needs reconsideration.
This is a bounded report operation, not a general retry or terminal-run resume.

```ts
subagent({
  action: "report.correct",
  id: "<exact terminal reviewer run id>",
  message: "Reassess the suspected report-format explanation using retained inspection evidence. Preserve any real gaps.",
  options: { index: 0, timeoutMs: 120000 },
});
```

`index` selects a child of a multi-child run. The exact run must belong to the
current parent and be complete or failed, not live, paused, stopped, or unknown.
The source session's normal revival lease excludes concurrent correction/resume.
No launch, model, output, schema, worktree or agent override is accepted. The
operation waits for one report turn, bounded by the requested timeout (maximum
five minutes) and cancellation. It never retries automatically.

## Eligibility and identity

New local native launches with `acceptanceRole: read-only` and `outputSchema`
retain a private source record on their session's active branch. The record binds
run, parent, session, model and original schema to the subject captured before
inspection, together with stable SDK entry identities for that launch. A successful
inspection-tool result and a structured submission from that launch must remain
in the SDK projection. Compaction can shift message positions without invalidating
retained current-launch evidence; summaries alone and earlier-launch reads cannot
certify current inspection. Empty evidence, writer launches, accepted clean reports, provider
errors, aborted turns and later context changes do not qualify.

The two eligible terminal states are distinct:

- **Rejected:** no report was captured; retained arguments and validation results
  remain evidence. Ordinary repair before a successful first submission is still
  supported directly by `structured_output` and is unchanged.
- **Captured blocked:** an accepted report remains terminal historical evidence.
  Correction produces an amendment, never a replacement of that captured value.

Git identity includes HEAD, native index tree, tracked working-tree fingerprints,
local/remote branch refs (including the review base), bounded untracked file
content, and recursive initialized submodule subjects. Unavailable or excessively
nested submodules are visibly ineligible; dirty gitlinks alone are not identity. Changing even an unrelated branch ref invalidates this conservative
retained snapshot. Ignored files and external services are not pinned. Reviews
whose subject depends on those need separately immutable evidence; correction
cannot create it. Tracked `assume-unchanged`/`skip-worktree` subjects, unavailable
Git identity, oversized/unavailable snapshots, or subject changes during the
review/correction are ineligible. No flags are cleared. The original missing-call
recovery's Git-native index and flagged-subject behavior is unchanged.

Old sessions without this record cannot be retroactively certified. An
ineligible source gets a visible error; if substantive work is still needed,
launch an explicitly labeled independent review of the current subject. Do not
edit old session records or artifacts to make them eligible.

Retention performs bounded Git scans only for read-only schema reviewers, not
normal children or status polling. Five measurements on the task-8002 dirty
checkout were 106, 92, 93, 95 and 104 ms per subject capture. These are local
provenance, not a latency guarantee or a mandatory checkout configuration.

## What runs and what is preserved

The same reviewer model receives a separate copy of the retained session, with
only `structured_output` executable. Every other tool, including inspection,
coordination, delegation, MCP and writes, is denied by native dispatch and latches
a failure. No ambient extensions, project context or skills are rediscovered;
required child extensions remain enforced. Original messages/schema are retained,
not replaced with a fresh task summary. The correction prompt is appended. The
source transcript and subject are rechecked before capture and publication.

The result exposes `details.reportCorrection` and a new private
`report-corrections/<correction-id>/correction.json` beside the retained session.
The artifact contains the source run/session/digest, original rejected/blocked
value, schema-validated `proposedReport`, and correction-session path. Its status
is always `unassessed`: it is not a normal authoritative `structuredOutput` child
result and cannot automatically satisfy a clean-review gate. Original output
files, status, workflow lane results, receipts and notifications are not rewritten.
Artifacts use exclusive creation; a new explicit correction gets its own identity.
Failed attempts may leave a private diagnostic session but no accepted amendment.

## Consuming the result

Read both the original evidence and the amendment. A request describing a
"format-only blocker" is a hypothesis, not evidence or an instruction to return
clean. The reviewer must derive missing coverage/verdict from retained inspection,
keep real coverage gaps blocked, and preserve uncertainty. Existing substantive
`findings` from an accepted blocked report cannot be removed or rewritten by this
operation; use a fresh independent review for substantive re-review. Rejected
finding shapes may be repaired without dropping finding entries; their exact
original substance remains in the unassessed artifact for controller comparison. The original blocker and transcript remain in
the artifact even when the reviewer corrects its explanation.

Even an unsupported clean proposal leaves the original coverage blocker intact
and the amendment unassessed. Returning a candidate does not resolve that blocker.
Schema validation establishes report shape, not semantic correctness, completed
coverage or approval. The controller still assesses the corrected substantive
report against the original evidence and exact review subject. No blocked-to-clean
conversion, merge approval, or acceptance is inferred by the runtime.

## Focused proof

`test/unit/report-correction.test.ts` composes source-retention hooks, the public
management dispatcher, source-session leases and native tool gates. Sanitized
PR57-style fixtures exercise rejected submissions separately from accepted format
blockers, retaining originals while obtaining a substantive verdict. A retained
coverage-gap fixture stays blocked. Negative cases cover identity, branch history,
missing inspection, writer sources, source/subject changes, concurrent correction,
substantive findings, forbidden tools and queued input.

The model/provider/session transport is simulated in these unit fixtures. They
prove protocol and persisted-artifact behavior, not that every model will correctly
interpret retained evidence. Existing completion/recovery suites separately prove
the original same-session missing-call path and ordinary in-turn report repair.

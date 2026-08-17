# Pi Subagents: Agent Catalog

This file is a detailed reference loaded from `skills/pi-subagents/SKILL.md`.
Read it only after the parent has decided to delegate work to a subagent. The
catalog and the agent-selection guidance below are not useful before that
decision, and loading them earlier just to "check" wastes context for sessions
that end up doing the work themselves.

## Capability ceilings

Parent extensions may register a session-scoped, out-of-band ceiling through `pi-subagents/capability-ceiling`. Child tools and eligible canonical agent names are intersected with every active registration and inherited snapshot; `denyExtensions` removes ambient/provider extension loading while retaining package protocol runtime. `{ action: "list" }` marks non-allowlisted agents as restricted, and launch rejects them before spawn. Do not add a model-visible ceiling field or rely on unrestricted role selection for enforcement. Restricted schedules are rejected until their ceiling can be persisted safely.

## Tool vs Slash Commands

Agents use the `subagent(...)` tool with `workflowScript` for execution, and `action` for management, status, and control. Humans often use the slash-command layer instead:

- `/run` — launch a single agent
- `workflowScript` — the sole public surface for sequence, parallelism, branching, retries, and aggregation
- `/subagents` — interactive admin for inspecting agents and editing model, thinking, or system prompt
- `/subagents-stop [run-id]` — stop a current-session top-level async run; opens a selector when no id is given
- `/subagents-detach [run-id]` — detach an active foreground single-subagent run without terminating its child
- `/subagent-cost` — show parent plus child token usage and cost for the session
- `/subagents-fleet` — open the live fleet inspector with per-child controls; `Ctrl+Alt+F` opens it during an active foreground turn, `↑↓`/`jk` selects children, `PgUp`/`PgDn` scrolls transcript detail, `s` steers the selected live async child, and `D` stops its top-level async run after confirmation
- `/subagents-watchdog` — inspect or configure the opt-in adversarial change watchdog (model, on/off, recommend-model, check)
- `/subagents-doctor` — diagnose setup, discovery, async paths, and intercom bridge state
- `/subagents-models [agent]` — show the live runtime-loaded builtin model mapping
- `/subagents-profiles`, `/subagents-load-profile`, `/subagents-refresh-provider-models`, `/subagents-generate-profiles`, `/subagents-check-profile` — manage model profiles and provider catalogs
- `/prompt-workflow` — run a prompt template through native workflowScript execution

Prefer the tool when you are writing agent logic. Prefer the slash commands when
you are guiding a human through an interactive flow.

Packaged prompt shortcuts are also available for repeatable workflows. Treat them as reusable orchestration recipes, not just human slash commands. When the user asks for one of these shapes, or when the workflow clearly fits, apply the same pattern directly with `subagent(...)` and other tools (see `references/orchestration-recipes.md` for the full recipes):

- `/parallel-review` — fresh-context reviewers with distinct review angles, then synthesis
- `/review-loop` — parent-orchestrated worker, fresh-reviewer, and fix-worker cycles until clean or capped
- `/parallel-research` — combine `researcher` and `scout` for external evidence plus local code context
- `/gather-context-and-clarify` — scout/research first, then ask the user clarifying questions with `interview`
- `/parallel-cleanup` — two fresh-context reviewers (deslop + verbosity passes) for an adversarial cleanup review of the current diff

## Builtin Agents

Builtin agents load at the lowest priority. Project agents override user agents,
and user/project agents override builtins with the same name.

| Agent | Purpose | Model | Typical output / role |
| ------- | --------- | ------- | ------------------------ |
| `scout` | Fast codebase recon | inherits default | Writes `context.md` handoff material |
| `worker` | Implementation and approved oracle handoffs | inherits default | Single-writer implementation with decision escalation |
| `reviewer` | Review specialist | inherits default | Default recipes are review-only; tools include edit/write when a fix pass is explicit |
| `researcher` | Web research brief generator | inherits default | Writes `research.md` |
| `delegate` | Lightweight generic delegate | inherits default | No fixed output; generic delegated work |
| `oracle` | Decision-consistency advisory review | inherits default | Advisory review, intercom coordination |
| `advisor` | Claude Code-compatible alias for `oracle` | inherits default | Same advisory role as `oracle` |

Builtin `worker` and `delegate` use strict tool allowlists and do not inherit ambient parent extension tools. To give a child an extension tool, name it in `tools` and load its provider via `extensions`, a path-like `tools` entry, or `subagentOnlyExtensions`. Custom agents without an `extensions` field follow `subagents.defaultExtensions` when set.

Builtin agents inherit the current Pi default model unless a run, user setting, project setting, or `subagents.defaultModel` overrides `model`. Set `subagents.defaultModel` when subagents should use a different default model than the parent session. Override builtin defaults before copying full agent files when a small tweak is enough.

Set `subagents.defaultThinking` to apply a shared thinking level to builtin, package, user, and project agents whose frontmatter leaves `thinking` unset. Project settings win over user settings; explicit frontmatter (including `thinking: false`), `agentOverrides.<name>.thinking`, and per-run overrides remain more specific. This setting affects child agents only and does not change the parent session's default thinking level.

```json
{
  "subagents": {
    "defaultThinking": "medium"
  }
}
```

For one run, use inline config:

```text
/run reviewer[model=anthropic/claude-sonnet-4] "Review this diff"
```

For persistent tweaks, edit `subagents.agentOverrides` in user or project settings. User overrides apply everywhere. Project overrides apply only in that repo and win over user overrides. Use `/subagents-models` or `subagent({ action: "models" })` to inspect the live mapping after settings and overrides load.

Model ids do not have to be exact. Separator variations (`claude-haiku-4.5` vs `claude-haiku-4-5`), case (`Claude-Sonnet-4`), and optional trailing date stamps (`claude-haiku-4-5-20251001`) all resolve to the same registry model. Exact `provider/id` wins; a qualified `provider/model` never switches providers. To constrain subagents to a budget or compliance profile, set `subagents.modelScope: { enforce: true, allow: ["anthropic/*", "openai/gpt-5-*"] }` in user or project settings. Out-of-scope models you pass explicitly error and abort; models inherited from frontmatter, `subagents.defaultModel`, agent frontmatter, or the parent session only warn.

For model fleets, use the profile commands instead of hand-editing repeated overrides: `/subagents-refresh-provider-models <provider>`, `/subagents-generate-profiles <provider>`, `/subagents-load-profile <name>`, and `/subagents-check-profile <name>`. Profiles live under `~/.pi/agent/profiles/pi-subagents/` and replace only `settings.subagents` when loaded.

## Prompting role subagents

Builtin role agents inherit the current Pi default model unless you override them. When launching them, write the task prompt as a compact contract, not a long procedural script. Define the destination and let the role choose the efficient path.

A strong subagent prompt usually includes:

- **Goal**: the concrete outcome the child should produce.
- **Target**: repository, explicit `cwd`, branch/ref/head, and source seam when the target is not the parent cwd.
- **Authority boundary**: whether the child may read, edit, commit, push, comment, close, merge, publish, or release. Omit or forbid actions that are not approved.
- **Context/evidence**: relevant plan paths, files, diffs, decisions, or user constraints already approved.
- **Success criteria**: what must be true before the child can finish.
- **Hard constraints**: true invariants only, such as no edits for review-only tasks, one writer thread, child must not run subagents unless it is an explicitly assigned `tools: subagent` fanout child, or escalation for unapproved decisions.
- **Validation**: targeted checks to run, or the next-best check when validation is impossible.
- **Output**: the expected summary shape, artifact path, or finding format. Use repo-qualified durable output paths for cross-codebase waves.
- **Stop rules**: when to ask via `intercom` or `contact_supervisor`, when to stop after enough evidence, and when not to keep searching.

Avoid carrying over old prompt habits that over-specify every step. Use `must`, `always`, and `never` for real invariants; for judgment calls, give decision rules. For example, tell a reviewer to inspect the staged diff directly and report only evidence-backed findings, rather than prescribing every file or command. Tell a researcher the retrieval budget: start with broad targeted searches, fetch only the strongest sources, search again only when a required fact is missing, then stop.

For implementation handoffs, name the approved scope and success criteria more clearly than the process. Good prompts say what to change, what not to change, where the evidence lives, how to validate, and when to escalate. They should not ask the child to create another subagent plan or continue the parent conversation.

Settings locations:

- User scope: `~/.pi/agent/settings.json`
- Project scope: `.pi/settings.json`

Direct settings example:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high",
        "fallbackModels": ["openai/gpt-5-mini"],
        "acceptanceRole": "read-only"
      }
    }
  }
}
```

Useful override fields: `description`, `model`, `fallbackModels`, `thinking`,
`systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`,
`acceptanceRole`, `disabled`, `skills`, `tools`, `extensions`, and `systemPrompt`.
`description` replaces the discovered description for builtin and custom agents
in `list` output, which is useful for deployment-specific routing notes.
Use `acceptanceRole: false` to clear an override. Create a user or project
agent with the same name only when you want a substantially different agent.

### Recommended model tiering (optional)

When several providers are available, route agents by task shape instead of one model for everything:

1. **Fast workhorse** — cheapest capable model at low thinking for recon, lookups, and mechanical edits (for example on `scout`).
2. **Standard well-scoped** — mid-tier model at medium thinking for most delegations: routine multi-file edits, focused reviews, straightforward implementation (for example on `worker`, `reviewer`, `delegate`).
3. **Deep but bounded** — top reasoning model at high thinking only for hard tasks that arrive with explicit goals and completion criteria; these models loop on vague goals (for example on oracle-style agents).
4. **Taste and intent** — a model that reads human intent well for ambiguous work: UX/design judgment, product tradeoffs, planning from vague requirements, writing quality.

Routing rule: use tiers 1–3 when the task is well-scoped; use tier 4 when scoping or judging is the task itself. Give tier-4 agents cross-provider `fallbackModels` so subscription usage limits degrade gracefully; fallback triggers automatically on rate-limit and overload errors. Note that forked context over an Anthropic parent transcript with signed thinking blocks forces the child's thinking off, so intent-tier agents work best with fresh context.

If a provider rejects model IDs with thinking suffixes, use
`subagents.disableThinking: true` in user or project settings to clear bundled
builtin thinking defaults globally. A higher-precedence per-agent `thinking`
override can opt one builtin back in. Existing custom-agent frontmatter remains authoritative.

Set `subagents.defaultExtensions` to give agents without an `extensions` field a shared child extension allowlist. Omit it to preserve ambient extension discovery, set it to `[]` to disable ambient extensions by default, or use `agentOverrides.<name>.extensions` for one agent. Explicit custom-agent frontmatter still wins.

Tool description modes live in `~/.pi/agent/extensions/subagent/config.json`, not `subagents` settings. The default uses split prompt metadata: a short tool description plus active `promptSnippet` and `promptGuidelines`. Set `toolDescriptionMode` to `full` or `compact` to force one description string, or `custom` to read `subagent-tool-description.md` from the project config dir or agent dir; invalid custom files fall back to full mode and the safety guidance is still appended.

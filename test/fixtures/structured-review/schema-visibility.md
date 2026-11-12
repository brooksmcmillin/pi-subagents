# Structured-output visibility reproduction (task 8000)

## Observed boundary

The runtime constructs `parameters` once with `createStructuredOutputToolParameters`, registers those parameters, and serializes that same object into the tool description. There is no hand-maintained production report shape. Local `$ref` scoping and optional/required acceptance arguments remain owned by the parameter constructor. Submission still uses raw-value preparation and authoritative value validation; neither is loosened.

`subagent-prompt-runtime.test.ts` captures actual runtime registration with the sanitized soundness contract in `specialist-schema.ts`, then calls Pi's real `convertResponsesTools`. It asserts exact description and parameter preservation, including all identity fields, eight nested threat families, enums and `if`/`then` constraints. A changed schema adds a required identity without changing presentation code. Missing identity, unknown status, blocked-without-reason and checked-without-location values still reject.

The fixture derives from `brooksmcmillin/infra@939706b6812b67fab9b1f61677f3e959d36d12aa:.pi/extensions/specialist-pr-review/workflow.ts:4-76` with synthetic identity constants. It is a test snapshot, not another production contract. Consumer inventory: native launch/preflight transports the resolved schema; workflow `runs.run`/`runs.all`, agent-default schemas, infra specialist review and sprint-controller consume it. No shared role prompt or consumer API changed.

Pinned development peers: Pi 1.2.0. Installed-runtime replay: Pi 1.5.2 using `native-peer-loader.mjs`. Both passed all 82 runtime tests on 2026-11-12. This shows preservation through these local conversion paths, **not** what the historical remote provider rendered or what a model attended to. The original presentation-loss mechanism remains unproved.

## Bounded live child

`schema-visibility-benchmark.ts` is an opt-in Pi extension that loads the candidate runtime directly, waits for the validator as normal child startup does, and exposes only `structured_output`. It records sanitized counts, model/schema identities and the synthetic validated report, never full requests or credentials. `PI_SCHEMA_BENCHMARK_INCOMPLETE_TYPES=1` replaces only model-facing parameter types with an unconstrained `value`, simulating incomplete rendering. The candidate description and production validators remain intact. This simulation is not a claim about provider behavior.

Run from this checkout with an already configured provider/model (the recorded model is provenance, not a requirement):

```sh
PI_SCHEMA_BENCHMARK_OUTPUT=/tmp/schema-visibility-new.json \
PI_SCHEMA_BENCHMARK_INCOMPLETE_TYPES=1 \
pi --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes \
  --no-context-files --no-session --offline --tools structured_output \
  -e ./test/fixtures/structured-review/schema-visibility-benchmark.ts \
  --provider openai-codex --model gpt-6.1-sol --thinking low \
  --system-prompt 'You are a bounded report-only child. Read the authoritative argument schema in the structured_output description. Make exactly one structured_output call, no prose or rejection-based discovery. This is synthetic evidence, not a real review.' \
  -p 'Submit a clean synthetic report for fixture.ts:1. Include required identity constants and every threatMatrix family. Each row is checked with fixture.ts:1 and a short synthetic reason.'
```

Inspect the result's `passed`, counters and complete `value`; CLI exit alone is not proof. The committed `schema-visibility-observation.json` records the successful run on Pi 1.5.2, Node v25.1.0, openai-codex/gpt-6.1-sol, low reasoning: one request containing the description, one accepted call, zero errors, all eight nested rows. Schema SHA-256 is recorded in that artifact. Runtime source was based on `3ef49fa48f3148cb73760ad98e03cf76449f086d`, with `subagent-prompt-runtime.ts` SHA-256 `162927c0bef4ad6ebefb823034394a229a47315c13bdda093a7f5bca97fbe3b8`.

Two earlier harness attempts did not await validator initialization: each had one rejected call and no captured report (the second retained diagnostic was `Structured output validator is still loading; call structured_output again.`). The benchmark was corrected to mirror normal startup; no production validator change was needed. These attempts are not schema-visibility passes.

The representative argument schema is 5,935 bytes; its full description is 6,225 bytes. This extra schema copy buys a text channel independent of parameter-type rendering without adding a tool, filesystem access or recovery exceptions. No status/watcher hot path changed. This single synthetic reporting run does not prove review quality, universal model/provider reliability, historical causality, or refresh of any user installation.

## Focused local commands

```sh
node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --test test/unit/subagent-prompt-runtime.test.ts
PI_SUBAGENTS_NATIVE_PI_ROOT=/path/to/pi-coding-agent node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --import ./test/support/native-peer-loader.mjs --test test/unit/subagent-prompt-runtime.test.ts
```

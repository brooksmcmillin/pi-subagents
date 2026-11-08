# Structured review startup fixture

`quick-review.md` snapshots the operator's named read-only review role (2026-11-08), including its ordinary static tool list. It is discovered through the real agent parser, not replaced with a synthetic `AgentConfig`. Only the model and extension selection are overridden for isolation; `structured_output` must still be injected dynamically.

`structured-review-background.test.ts` launches a real detached runner with the real SDK/default child factory. The faux provider inspects the first request's tool declarations and schema, submits one valid report, and terminates. The test reads the persisted result/output and passes that result through the parent's completion notifier. A second launch without a schema checks ordinary-child behavior. It proves construction, registration, validation, persistence and notification plumbing—not review quality, live-provider reliability, or the historical cause.

`structured-output-startup.test.ts` injects missing registration, hidden/inactive registration, inline load failure and startup-handler failure into real SDK construction. All fail with zero provider calls; post-bind failures shut down the created session. Startup errors retain the inline extension identity, event, safe error category (when supplied by the SDK) and SHA-256 fingerprint. Raw exception text/stack is deliberately omitted because an extension can put credentials or prompt contents there. SDK message-only errors are labeled `ExtensionError`; their fingerprint permits matching an independently inspected local error without publishing its contents.

Run focused coverage from the repository root:

```sh
node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --test test/unit/structured-output-startup.test.ts test/unit/structured-review-background.test.ts
```

The same files can use an installed SDK through the existing native-peer loader:

```sh
PI_SUBAGENTS_NATIVE_PI_ROOT=/path/to/pi-coding-agent node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --import ./test/support/native-peer-loader.mjs --test test/unit/structured-output-startup.test.ts test/unit/structured-review-background.test.ts
```

## Historical evidence limits

The three retained launch descriptors cited by task 7896 all carry a structured schema and the same static tool names (`read`, `grep`, `find`, `ls`, `bash`). Their session tool declarations initially contain `read` and `bash` (line 5). The two successful probe sessions append `grep`, `find`, `ls`, and `structured_output` (line 11); the failed session has no such declaration. This confirms the exposure difference, not its cause. No static role-tool workaround or automatic reload is introduced.

## Direct lifecycle consumers

Startup: `child-session.ts` owns construction/binding; the prompt runtime owns SDK registration and activation. The new host gate rejects before returning a schema-bound child to foreground or background callers. No persisted schema, replay, ownership, or notification protocol changes. Background dispatch/report: the existing async launcher, runner, result writer and parent notifier are exercised together by the benchmark; there is no new recovery path. CI's unit-test glob includes both new files and the existing typecheck covers runtime sources. Installed SDK variants require the explicit native command above; they are not inferred from the default pinned-SDK run.

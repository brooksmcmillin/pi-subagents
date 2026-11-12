import assert from "node:assert/strict";
import test from "node:test";
import type { JsonSchemaObject } from "../../src/shared/types.ts";
import { MAX_STRUCTURED_OUTPUT_REJECTION_ERROR_BYTES, prepareStructuredOutputArguments, validateStructuredOutputValue } from "../../src/runs/shared/structured-output.ts";
import { specialistSchema, threatFamilies } from "../fixtures/structured-review/specialist-schema.ts";

async function invalidMessage(schema: JsonSchemaObject, value: unknown): Promise<string> {
	const result = await validateStructuredOutputValue(schema, value);
	assert.equal(result.status, "invalid");
	return result.status === "invalid" ? result.message : "";
}

function cleanReport() {
	return {
		status: "clean", scopeChecked: "Synthetic subject", baseRef: "a".repeat(40), stagedTree: "b".repeat(40),
		findings: [], next: "Proceed", blockedReason: "",
		threatMatrix: Object.fromEntries(threatFamilies.map((family) => [family, {
			status: "checked", evidence: "src/example.ts:1", reason: "Inspected synthetic subject",
		}])),
	};
}

test("distinguishes forbidden wrappers from missing report identities", async () => {
	const schema = {
		type: "object", additionalProperties: false, required: ["baseRef", "stagedTree"],
		properties: { baseRef: { type: "string" }, stagedTree: { type: "string" } },
	};
	const message = await invalidMessage(schema, { blockers: ["PRIVATE-SUBMITTED-VALUE"] });
	assert.match(message, /baseRef: is required; expected \{"type":"string"\}/);
	assert.match(message, /stagedTree: is required/);
	assert.match(message, /blockers: unexpected property; remove it; declared properties: "baseRef", "stagedTree"/);
	assert.doesNotMatch(message, /schema is false|PRIVATE-SUBMITTED-VALUE/);
	assert.equal(message.match(/blockers: unexpected property/g)?.length, 1);
	assert.throws(() => prepareStructuredOutputArguments(schema, { value: { blockers: [] } }), /blockers: unexpected property/);
});

test("gives missing nested PR57-style fields their declared shapes without inventing wrappers", async () => {
	const report = { ...cleanReport(), threatMatrix: { ...cleanReport().threatMatrix, reportedCase: { checked: true } } };
	const message = await invalidMessage(specialistSchema, report);
	assert.match(message, /threatMatrix.reportedCase.status: is required; expected .*"enum":\["checked","not-applicable","blocked"\]/);
	assert.match(message, /threatMatrix.reportedCase.evidence: is required; expected .*"type":"string"/);
	assert.match(message, /threatMatrix.reportedCase.reason: is required; expected .*"minLength":1/);
	assert.match(message, /threatMatrix.reportedCase.checked: unexpected property; remove it/);

	const corrected = cleanReport();
	const unchanged = JSON.stringify(corrected);
	assert.deepEqual(await validateStructuredOutputValue(specialistSchema, corrected), { status: "valid" });
	assert.equal(JSON.stringify(corrected), unchanged);
	assert.equal((prepareStructuredOutputArguments(specialistSchema, { value: corrected }) as { value: unknown }).value, corrected);
	corrected.threatMatrix.reportedCase.evidence = "not a citation";
	assert.match(await invalidMessage(specialistSchema, corrected), /threatMatrix.reportedCase.evidence: must match pattern/);
});

test("includes the missing object or array item contract, including local refs", async () => {
	const schema = {
		type: "object", required: ["finding", "findings"],
		$defs: { finding: { type: "object", required: ["evidence"], properties: { evidence: { type: "string" } } } },
		properties: { finding: { $ref: "#/$defs/finding" }, findings: { type: "array", items: { type: "string" } } },
	};
	const message = await invalidMessage(schema, {});
	assert.match(message, /finding: is required; expected \{"type":"object","required":\["evidence"\],"properties"/);
	assert.match(message, /findings: is required; expected \{"type":"array","items":\{"type":"string"\}\}/);
	assert.match(await invalidMessage(schema, { finding: [], findings: {} }), /finding: must be object; findings: must be array/);
});

test("uses unambiguous escaped paths for forbidden or missing property names", async () => {
	const name = "a.b/\u001b\n~";
	const schema = { type: "object", additionalProperties: false, required: [name], properties: { [name]: { type: "string" } } };
	const message = await invalidMessage(schema, { "bad.key/\n": "PRIVATE-SUBMITTED-VALUE" });
	assert.ok(message.includes(`[${JSON.stringify(name)}]: is required`));
	assert.ok(message.includes(`[${JSON.stringify("bad.key/\n")}]: unexpected property`));
	assert.doesNotMatch(message, /[\u0000-\u001f\u007f]|PRIVATE-SUBMITTED-VALUE/);
	assert.match(await invalidMessage({ type: "object", required: ["input"], properties: { input: { type: "string" } } }, {}), /^input: is required/);
});

test("retains eight-error and UTF-8 byte limits for large contracts without echoing values", async () => {
	const names = Array.from({ length: 12 }, (_, index) => `field${index}`);
	const message = await invalidMessage({
		type: "object", required: names,
		properties: Object.fromEntries(names.map((name) => [name, { type: "object", required: ["nested"], properties: { nested: { enum: ["🦄".repeat(2000)] } } }])),
	}, {});
	assert.equal(message.match(/: is required/g)?.length, 8);
	assert.ok(Buffer.byteLength(message) <= MAX_STRUCTURED_OUTPUT_REJECTION_ERROR_BYTES);
	assert.doesNotMatch(message, /\ufffd/);
	const hugeEnum = await invalidMessage({ enum: ["🦄".repeat(2000)] }, "PRIVATE-SUBMITTED-VALUE");
	assert.ok(Buffer.byteLength(hugeEnum) <= MAX_STRUCTURED_OUTPUT_REJECTION_ERROR_BYTES);
	assert.ok(hugeEnum.endsWith("..."));
	assert.doesNotMatch(hugeEnum, /\ufffd|PRIVATE-SUBMITTED-VALUE/);
});

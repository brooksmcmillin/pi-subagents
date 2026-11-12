// Sanitized soundness contract from brooksmcmillin/infra@939706b6:
// .pi/extensions/specialist-pr-review/workflow.ts:4-76. Identity values are synthetic.
const text = { type: "string", minLength: 1, maxLength: 4000 };
const evidence = { ...text, pattern: "^.+:[1-9][0-9]*(?:-[1-9][0-9]*)?$" };
export const threatFamilies = [
	"reportedCase", "adjacentBoundaries", "malformedOrTruncated", "aliasesAndRebinding",
	"nestedAndRepeatedScopes", "deadOrConditionalPaths", "dynamicLookupOrLoading", "alternateCallers",
];
export const specialistSchema = {
	type: "object", additionalProperties: false,
	required: ["status", "scopeChecked", "baseRef", "stagedTree", "findings", "next", "blockedReason", "threatMatrix"],
	properties: {
		status: { type: "string", enum: ["clean", "findings", "blocked"] },
		scopeChecked: text,
		baseRef: { const: "a".repeat(40) },
		stagedTree: { const: "b".repeat(40) },
		findings: {
			type: "array", maxItems: 20,
			items: {
				type: "object", additionalProperties: false,
				required: ["severity", "evidence", "impact", "next"],
				properties: { severity: { type: "string", enum: ["blocker", "risk", "note"] }, evidence, impact: text, next: text },
			},
		},
		next: text,
		blockedReason: { type: "string", maxLength: 4000 },
		threatMatrix: {
			type: "object", additionalProperties: false, required: threatFamilies,
			properties: Object.fromEntries(threatFamilies.map((family) => [family, {
				type: "object", additionalProperties: false,
				required: ["status", "evidence", "reason"],
				properties: {
					status: { type: "string", enum: ["checked", "not-applicable", "blocked"] },
					evidence: { type: "string", maxLength: 4000 }, reason: text,
				},
				allOf: [{
					if: { properties: { status: { const: "checked" } }, required: ["status"] },
					then: { properties: { evidence } },
				}],
			}])),
		},
	},
	allOf: [
		{ if: { properties: { status: { const: "clean" } }, required: ["status"] }, then: { properties: { findings: { maxItems: 0 }, blockedReason: { maxLength: 0 } } } },
		{ if: { properties: { status: { const: "findings" } }, required: ["status"] }, then: { properties: { findings: { minItems: 1 }, blockedReason: { maxLength: 0 } } } },
		{ if: { properties: { status: { const: "blocked" } }, required: ["status"] }, then: { properties: { blockedReason: { minLength: 1 } } } },
	],
};

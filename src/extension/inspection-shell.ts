import { spawn } from "node:child_process";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_OUTPUT_BYTES = 50 * 1024;
const SAFE_GIT_SUBCOMMANDS = new Set([
	"cat-file",
	"describe",
	"diff",
	"for-each-ref",
	"grep",
	"log",
	"ls-files",
	"merge-base",
	"rev-parse",
	"show",
	"shortlog",
]);
const SAFE_GH_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
	issue: new Set(["list", "status", "view"]),
	pr: new Set(["checks", "diff", "list", "status", "view"]),
	release: new Set(["list", "view"]),
	repo: new Set(["list", "view"]),
	run: new Set(["list", "view"]),
};
const GH_BLOCKED_FLAGS = new Set([
	"-F",
	"-R",
	"-f",
	"-X",
	"--field",
	"--hostname",
	"--input",
	"--method",
	"--raw-field",
	"--repo",
	"--web",
]);
const NO_TEXTCONV_GIT_SUBCOMMANDS = new Set(["diff", "log", "show"]);
const GIT_DANGEROUS_OPTIONS = new Set([
	"-c",
	"-o",
	"-p",
	"--config-env",
	"--exec-path",
	"--ext-diff",
	"--filters",
	"--git-dir",
	"--open-files-in-pager",
	"--output",
	"--paginate",
	"--show-signature",
	"--textconv",
	"--upload-pack",
	"--work-tree",
]);

const parameters = Type.Object({
	program: Type.Union([Type.Literal("git"), Type.Literal("gh")], {
		description: "Inspection program to run. Only read-only git and GitHub CLI operations are available.",
	}),
	args: Type.Array(Type.String({ minLength: 1 }), {
		description: "Arguments only, without shell quoting, pipes, redirects, or command substitution.",
		maxItems: 32,
	}),
});

type InspectionParams = {
	program: "git" | "gh";
	args: string[];
};

function invalid(reason: string): { ok: false; reason: string } {
	return { ok: false, reason };
}

function hasBlockedGhArgument(args: string[]): boolean {
	return args.some((arg) => GH_BLOCKED_FLAGS.has(arg)
		|| /^(?:-X|-f|-F|-R)/.test(arg)
		|| /^(?:--method|--raw-field|--field|--input|--hostname|--repo)=/.test(arg));
}

/** Reject command forms that can select a mutating command or inject shell behavior. */
export function validateInspectionCommand({ program, args }: InspectionParams): { ok: true } | { ok: false; reason: string } {
	if (args.length === 0) return invalid("An inspection command needs a subcommand.");
	if (args.some((arg) => /[\n\r\0|&;<>`$()]/.test(arg))) {
		return invalid("Shell syntax is not accepted; pass literal arguments only.");
	}

	if (program === "git") {
		if (args.some((arg) => {
			const longOption = arg.split("=", 1)[0] ?? "";
			return GIT_DANGEROUS_OPTIONS.has(arg)
				|| arg.startsWith("-c")
				|| arg.startsWith("-o")
				|| (longOption.length > 2 && [...GIT_DANGEROUS_OPTIONS].some((option) => option.startsWith("--") && option.startsWith(longOption)));
		})) {
			return invalid("Git options that can alter configuration, write output, or execute external commands are not available in the inspection shell.");
		}
		const subcommand = args.find((arg) => !arg.startsWith("-"));
		if (!subcommand || !SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
			return invalid(`Git subcommand '${subcommand ?? ""}' is not allowlisted for read-only inspection.`);
		}
		return { ok: true };
	}

	const [group, command, ...rest] = args;
	if (group === "api") {
		if (command === undefined || command === "graphql" || !command.startsWith("/") || command.startsWith("//")) {
			return invalid("Only relative GitHub REST paths are available through 'gh api'; GraphQL, absolute URLs, and requests without an endpoint are blocked.");
		}
		if (hasBlockedGhArgument(args.slice(1))) {
			return invalid("GitHub API mutation and request-body flags are not available in the inspection shell.");
		}
		return { ok: true };
	}
	if (!group || !command || !SAFE_GH_SUBCOMMANDS[group]?.has(command)) {
		return invalid(`GitHub command '${args.slice(0, 2).join(" ")}' is not allowlisted for read-only inspection.`);
	}
	if (hasBlockedGhArgument(args)) {
		return invalid("GitHub mutation and request-body flags are not available in the inspection shell.");
	}
	return { ok: true };
}

export function buildInspectionArgs(program: "git" | "gh", args: string[]): string[] {
	if (program === "gh") return args;
	const subcommandIndex = args.findIndex((arg) => !arg.startsWith("-"));
	const gitArgs = NO_TEXTCONV_GIT_SUBCOMMANDS.has(args[subcommandIndex] ?? "")
		? [...args.slice(0, subcommandIndex + 1), "--no-textconv", ...args.slice(subcommandIndex + 1)]
		: args;
	return ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "--no-pager", ...gitArgs];
}

function runInspection(program: "git" | "gh", args: string[], cwd: string, signal: AbortSignal | undefined): Promise<{ output: string; exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const commandArgs = buildInspectionArgs(program, args);
		const child = spawn(program, commandArgs, {
			cwd,
			env: { ...process.env, GH_HOST: "github.com" },
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let bytes = 0;
		const append = (chunk: Buffer): void => {
			if (bytes >= MAX_OUTPUT_BYTES) return;
			const remaining = MAX_OUTPUT_BYTES - bytes;
			const kept = chunk.subarray(0, remaining);
			chunks.push(kept);
			bytes += kept.length;
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("error", reject);
		child.on("close", (exitCode) => resolve({
			output: `${Buffer.concat(chunks).toString("utf-8")}${bytes >= MAX_OUTPUT_BYTES ? "\n[output truncated]" : ""}`,
			exitCode,
		}));
		if (signal) {
			const abort = (): void => { child.kill("SIGTERM"); };
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});
}

export default function registerInspectionShell(pi: ExtensionAPI): void {
	const tool: ToolDefinition<typeof parameters, { program: string; args: string[]; exitCode: number | null }> = {
		name: "inspection_shell",
		label: "Inspection Shell",
		description: "Run an allowlisted, read-only git or gh inspection command. This tool does not invoke a shell and rejects every non-allowlisted program, subcommand, shell construct, API request body, and mutation flag.",
		parameters,
		async execute(_id, input, signal, _onUpdate, ctx) {
			const params = input as InspectionParams;
			const validation = validateInspectionCommand(params);
			if (!validation.ok) {
				return {
					content: [{ type: "text", text: `Blocked: ${validation.reason}` }],
					details: { program: params.program, args: params.args, exitCode: null },
					isError: true,
				};
			}
			const result = await runInspection(params.program, params.args, ctx.cwd, signal);
			return {
				content: [{ type: "text", text: result.output || "[no output]" }],
				details: { program: params.program, args: params.args, exitCode: result.exitCode },
				isError: result.exitCode !== 0,
			};
		},
	};
	pi.registerTool(tool);
}

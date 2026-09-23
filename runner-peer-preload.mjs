import * as nodeModule from "node:module";

const aliases = JSON.parse(process.env.JITI_ALIAS ?? "{}");
const nativeRunner = process.env.PI_ASYNC_NATIVE_RUNNER === "1";
const redirected = new Set([
	"@earendil-works/pi-tui",
]);

if (typeof nodeModule.registerHooks === "function") {
	nodeModule.registerHooks({
		resolve(specifier, context, nextResolve) {
			const alias = nativeRunner ? aliases[specifier] : redirected.has(specifier) && aliases[specifier];
			if (alias) {
				// This hook also serves require.resolve, which cannot resolve file URLs.
				return nextResolve(alias, context);
			}
			try {
				return nextResolve(specifier, context);
			} catch (error) {
				if (nativeRunner && specifier.endsWith(".js")) return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
				throw error;
			}
		},
	});
} else {
	nodeModule.register(new URL("./runner-peer-loader.mjs", import.meta.url), {
		data: { aliases, nativeRunner },
	});
}

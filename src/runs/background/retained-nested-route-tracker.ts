import * as fs from "node:fs";
import type { ForegroundRunControl, SubagentState } from "../../shared/types.ts";
import { shouldUseNativeFsWatch } from "../../shared/watch-strategy.ts";
import { hasLiveOwnedNestedWork, projectNestedEvents } from "../shared/nested-events.ts";
import { ownsRun } from "../shared/run-ownership.ts";
import { reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";

type RouteState = Pick<SubagentState, "retainedForegroundNestedRoutes">;
type RouteSession = { manager: object; id: string };
const reloadKey = Symbol.for("pi-subagents.foreground-route-reload");
const globals = globalThis as typeof globalThis & {
	[reloadKey]?: WeakMap<object, { id: string; routes: NonNullable<RouteState["retainedForegroundNestedRoutes"]>; retiredOwners: Set<string> }>;
};
const reloadRoutes = globals[reloadKey] ??= new WeakMap();

interface RetainedNestedRouteTrackerOptions {
	pollIntervalMs?: number;
	platform?: NodeJS.Platform;
	watch?: typeof fs.watch;
	onRoutesChanged?: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 5000;
const REFRESH_DEBOUNCE_MS = 25;

export function createRetainedNestedRouteTracker(
	state: RouteState,
	options: RetainedNestedRouteTrackerOptions = {},
) {
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const watch = options.watch ?? fs.watch;
	const watchers = new Map<string, fs.FSWatcher>();
	const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let poller: ReturnType<typeof setInterval> | undefined;
	let retiredOwners = new Set<string>();

	const close = (rootRunId: string): void => {
		watchers.get(rootRunId)?.close();
		watchers.delete(rootRunId);
		const timer = refreshTimers.get(rootRunId);
		if (timer) clearTimeout(timer);
		refreshTimers.delete(rootRunId);
	};

	const refresh = (rootRunId: string): void => {
		const retained = state.retainedForegroundNestedRoutes?.get(rootRunId);
		if (!retained) {
			close(rootRunId);
			return;
		}
		try {
			reconcileNestedAsyncDescendants(retained);
			if (hasLiveOwnedNestedWork(rootRunId, projectNestedEvents(retained).children, retiredOwners.has(rootRunId))) return;
			retiredOwners.delete(rootRunId);
			state.retainedForegroundNestedRoutes?.delete(rootRunId);
			close(rootRunId);
			options.onRoutesChanged?.();
		} catch (error) {
			console.error(`Failed to refresh retained nested descendants for foreground run '${rootRunId}':`, error);
		}
	};

	const scheduleRefresh = (rootRunId: string): void => {
		if (refreshTimers.has(rootRunId)) return;
		const timer = setTimeout(() => {
			refreshTimers.delete(rootRunId);
			refresh(rootRunId);
		}, REFRESH_DEBOUNCE_MS);
		timer.unref?.();
		refreshTimers.set(rootRunId, timer);
	};

	const ensurePoller = (): void => {
		if (poller || (state.retainedForegroundNestedRoutes?.size ?? 0) === 0) return;
		poller = setInterval(() => {
			for (const rootRunId of state.retainedForegroundNestedRoutes?.keys() ?? []) refresh(rootRunId);
			if ((state.retainedForegroundNestedRoutes?.size ?? 0) > 0) return;
			if (poller) clearInterval(poller);
			poller = undefined;
		}, pollIntervalMs);
		poller.unref?.();
	};

	const track = (rootRunId: string, ownerExited = false): void => {
		const retained = state.retainedForegroundNestedRoutes?.get(rootRunId);
		if (!retained) return;
		if (ownerExited) retiredOwners.add(rootRunId);
		if (shouldUseNativeFsWatch("retained-nested-route-tracker", options.platform) && !watchers.has(rootRunId)) {
			try {
				const watcher = watch(retained.eventSink, () => scheduleRefresh(rootRunId));
				watcher.on("error", () => close(rootRunId));
				watcher.unref?.();
				watchers.set(rootRunId, watcher);
			} catch {
				// The bounded safety poll below covers unsupported or failed watchers.
			}
		}
		scheduleRefresh(rootRunId);
		ensurePoller();
		options.onRoutesChanged?.();
	};

	const clear = (): void => {
		if (poller) clearInterval(poller);
		poller = undefined;
		for (const rootRunId of watchers.keys()) close(rootRunId);
		for (const timer of refreshTimers.values()) clearTimeout(timer);
		refreshTimers.clear();
		state.retainedForegroundNestedRoutes?.clear();
		retiredOwners.clear();
	};

	const captureReloadRoutes = ({ manager, id }: RouteSession, controls: Iterable<ForegroundRunControl> = []) => {
		const routes = new Map(state.retainedForegroundNestedRoutes);
		const retired = new Set(retiredOwners);
		for (const control of controls) {
			const route = control.nestedRoute;
			if (!route || route.rootRunId !== control.runId || !ownsRun(id, control.sessionId)) continue;
			try {
				if (!hasLiveOwnedNestedWork(route.rootRunId, projectNestedEvents(route).children, true)) continue;
			} catch {
				// Retry the exact owned route in the replacement runtime.
			}
			routes.set(route.rootRunId, route);
			retired.add(route.rootRunId);
		}
		if (routes.size) reloadRoutes.set(manager, { id, routes, retiredOwners: retired });
	};
	const restoreReloadRoutes = ({ manager, id }: RouteSession) => {
		const handoff = reloadRoutes.get(manager);
		reloadRoutes.delete(manager);
		if (handoff?.id !== id) return;
		state.retainedForegroundNestedRoutes = handoff.routes;
		retiredOwners = handoff.retiredOwners;
		for (const rootRunId of handoff.routes.keys()) track(rootRunId);
	};
	return { track, clear, captureReloadRoutes, restoreReloadRoutes };
}

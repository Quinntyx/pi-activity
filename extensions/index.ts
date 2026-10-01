/**
 * pi-activity — model-tagged activity labels and live activity tracking for pi.
 *
 * Extracted from pi-tool-tree (pi-claude-code-ui): the activity tracker, the
 * `activity` tool parameter wrapping, the label normalization, the shimmer
 * painter, the published query API, and the footer status line. Rendering of
 * the grouped transcript is not part of this plugin. pi-tool-tree is used only
 * as a reference; consumers can render this API however they want (see API.md).
 *
 * Three things live here:
 *
 * 1. Tracking — a headless listener on pi's own events that answers "what is
 *    the agent doing right now" (`getActivity`) and "what has it done this
 *    session" (`getStats`), with a change subscription. State is fed by events
 *    rather than by a renderer, so it is correct in hosts that never paint
 *    grouped rows (RPC, headless, tests).
 *
 * 2. Wrapping — the `activity` schema parameter the model tags every call
 *    with, injected into native tool schemas and opt-in tools via `wrapTool`.
 *    Existing extensions' tool definitions and custom renderers are left alone.
 *
 * 3. Presentation helpers — the shimmer painter (`shimmerText`) and the
 *    footer status line, so other surfaces get the exact same label sweep and
 *    a live "what is happening" line without re-implementing either.
 *
 * Public API reference: API.md.
 */

import { existsSync, readFileSync } from "node:fs";

import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { formatBashDuration } from "./bash-command";

const RESET = "\x1b[0m";
const TRANSPARENT_BG = "\x1b[49m";
const TRANSPARENT_RESET = `${RESET}${TRANSPARENT_BG}`;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface SettingsFile {
	/** Inject the required `activity` param into every wrapped tool schema. Default true. */
	toolActivityParam?: boolean;
	/** Show the current activity (label + elapsed) in pi's footer status cluster. Default true. */
	activityFooter?: boolean;
	/**
	 * When true (default), derive shimmer colors from the active pi theme via
	 * `theme.getFgAnsi`/`getBgAnsi` instead of the fixed fallbacks.
	 */
	themeAdaptive?: boolean;
}

let _settingsCache: { value: SettingsFile; timestamp: number } | null = null;
const SETTINGS_CACHE_TTL_MS = 5_000;

/** The pi global settings file for this run. Pi resolves its settings directory
 *  through $PI_CODING_AGENT_DIR (profile launchers like `ppi` set it to the active
 *  profile), so extension settings live beside pi's own settings.json there.
 *  Without the env var, fall back to the legacy home location. */
function activeGlobalSettingsPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
	if (agentDir) return `${agentDir.replace(/\/+$/, "")}/settings.json`;
	return `${process.env.HOME ?? ""}/.pi/settings.json`;
}

function readSettingsFile(path: string): Partial<SettingsFile> | undefined {
	try {
		if (!path || !existsSync(path)) return undefined;
		const raw = JSON.parse(readFileSync(path, "utf8"));
		return raw && typeof raw === "object" ? (raw as Partial<SettingsFile>) : undefined;
	} catch {
		return undefined; // ignore invalid settings files
	}
}

function readSettings(): SettingsFile {
	const now = Date.now();
	if (_settingsCache && now - _settingsCache.timestamp < SETTINGS_CACHE_TTL_MS) {
		return _settingsCache.value;
	}
	const projectPath = `${process.cwd()}/.pi/settings.json`;
	const legacyHomePath = `${process.env.HOME ?? ""}/.pi/settings.json`;
	const globalPath = activeGlobalSettingsPath();
	// Precedence (later wins): project < legacy home (kept so pre-profile installs
	// keep working) < the active profile's global settings — matching pi itself,
	// which reads $PI_CODING_AGENT_DIR/settings.json for this run.
	const paths = globalPath === legacyHomePath
		? [projectPath, legacyHomePath]
		: [projectPath, legacyHomePath, globalPath];
	const merged: SettingsFile = {};
	for (const path of paths) {
		Object.assign(merged, readSettingsFile(path) ?? {});
	}
	_settingsCache = { value: merged, timestamp: now };
	return merged;
}

function toolActivityParamEnabled(): boolean {
	return readSettings().toolActivityParam !== false;
}

function themeAdaptiveEnabled(): boolean {
	const settings = readSettings();
	return settings.themeAdaptive !== false;
}

function activityFooterEnabled(): boolean {
	return readSettings().activityFooter !== false;
}

// ---------------------------------------------------------------------------
// Activity labels
// ---------------------------------------------------------------------------

/** Activity labels group neighboring tool calls into model-named phases. */
export const ACTIVITY_PARAM = "activity";
export const ACTIVITY_WRAPPED = Symbol.for("pi-tool-tree:activity-wrapped");
export const DEFAULT_ACTIVITY_LABEL = "working";

/** Hard cap for a phase label. Long enough for two words, short enough that a
 *  rambling label cannot eat the group header. */
const ACTIVITY_LABEL_MAX = 24;

export function normalizeActivityLabel(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const label = raw.trim().toLowerCase().replace(/\s+/g, " ");
	if (label.length <= ACTIVITY_LABEL_MAX) return label;
	// Truncate on a word boundary: a mid-word cut ("checking ptc streaming u")
	// reads broken, dropping the last words reads intentional.
	const cut = label.slice(0, ACTIVITY_LABEL_MAX);
	const lastSpace = cut.lastIndexOf(" ");
	return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!-]+$/, "");
}

export function activityLabelOf(tool: any): string {
	return normalizeActivityLabel(tool?.args?.[ACTIVITY_PARAM]);
}

/** True between the start of a run and `agent_end`: the agent is still on this request,
 *  even in the quiet stretches where nothing is streaming and no call is in flight. */
export function agentWorking(): boolean {
	return typeof currentAgentWorkStartMs === "number";
}

// ---------------------------------------------------------------------------
// Worked-time / thinking-duration tracking
//
// The tracker's session totals (`workedMs`, resumed runs/turns/thinking) read
// message metadata stamped here: the same `WORKED_*` / `THINKING_*` keys
// pi-tool-tree's worked-time tracker wrote. Stamping them here keeps
// `getStats()` and resume seeding correct when this extension runs standalone.
// ---------------------------------------------------------------------------

const WORKED_DURATION_KEY = "_piClaudeStyleWorkedDurationMs";
const WORKED_START_KEY = "_piClaudeStyleWorkedStartMs";
const WORKED_SESSION_TOTAL_KEY = "_piClaudeStyleWorkedSessionTotalMs";
// Storage key string is frozen for resume compatibility: sessions written by
// older builds record the session prompt count under this name.
const WORKED_TURNS_KEY = "_piClaudeStyleWorkedTurns";
const THINKING_DURATION_KEY = "_piClaudeStyleThinkingDurationMs";
const THINKING_ACTIVE_KEY = "_piClaudeStyleThinkingActive";

/** Wall-clock start of the agent run in flight, or undefined while idle. */
let currentAgentWorkStartMs: number | undefined;
let currentAssistantMessageStartMs: number | undefined;
// Session-wide accumulator for completed agent work: the sum of finished runs.
// It must never include time spent idle while the user reads or writes a prompt.
// Re-seeded from persisted message metadata on resume/reload.
let sessionWorkedTotalMs = 0;
// Turns fired by the current agent run — pi's turn unit: one model response plus
// the tool calls it makes. Reset whenever a new run starts.
let currentRunTurnCount = 0;
let lastThinkingBlockDurationMs: number | undefined;
let thinkingBlockStartMs = 0;
/** True from thinking_start until thinking_end on the current assistant stream. */
let thinkingBlockInFlight = false;

function seedSessionTiming(messages: any[]): void {
	let workedTotalMs = 0;
	let runTurnCount = 0;
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if (message.role === "user") {
			runTurnCount = 0;
			continue;
		}
		if (message.role !== "assistant") continue;
		runTurnCount++;
		const stampedTurns = (message as any)[WORKED_TURNS_KEY];
		if (typeof stampedTurns === "number" && stampedTurns > 0) runTurnCount = stampedTurns;
		if (message.stopReason !== "stop") continue;
		const durationMs = (message as any)[WORKED_DURATION_KEY];
		if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) continue;
		workedTotalMs += durationMs;
		// Older builds stored wall-clock elapsed totals. Normalize loaded message
		// objects in memory so rerenders show cumulative work instead.
		(message as any)[WORKED_SESSION_TOTAL_KEY] = workedTotalMs;
		if (typeof stampedTurns === "number" && stampedTurns > 0) continue;
		// Transcripts written before turns were stamped: derive the run's turn
		// count from the assistant messages it produced.
		(message as any)[WORKED_TURNS_KEY] = runTurnCount;
	}
	sessionWorkedTotalMs = workedTotalMs;
}

function sessionBranchMessages(ctx: any): any[] | undefined {
	try {
		const entries = ctx?.sessionManager?.getBranch?.();
		if (!Array.isArray(entries)) return undefined;
		return entries
			.filter((entry: any) => entry?.type === "message" && entry.message)
			.map((entry: any) => entry.message);
	} catch {
		return undefined;
	}
}

/** Stamp thinking durations and worked-time metadata into assistant messages,
 *  so session totals and resume seeding survive restarts. Rendering concerns
 *  (live "Thinking..." rows, status lines) stay with the transcript renderer. */
function trackThinkingBlockEvents(event: any): void {
	const evt = event?.assistantMessageEvent;
	const message = event?.message;
	if (!evt || typeof evt.type !== "string") return;

	if (evt.type === "thinking_start") {
		thinkingBlockInFlight = true;
		thinkingBlockStartMs = Date.now();
		lastThinkingBlockDurationMs = undefined;
		if (message?.role === "assistant") {
			(message as any)[THINKING_ACTIVE_KEY] = true;
			delete (message as any)[THINKING_DURATION_KEY];
		}
		return;
	}
	if (evt.type === "thinking_end") {
		thinkingBlockInFlight = false;
		const duration = Math.max(0, Date.now() - thinkingBlockStartMs);
		if (message?.role === "assistant") delete (message as any)[THINKING_ACTIVE_KEY];
		lastThinkingBlockDurationMs = duration;
		if (message?.role === "assistant") (message as any)[THINKING_DURATION_KEY] = duration;
		return;
	}
	// Fallback: some providers/models never emit thinking_end (a second
	// thinking_start can overwrite the first, or the turn can end with toolUse).
	// Any non-thinking stream event on the same assistant message means thinking
	// is over: freeze the elapsed time into the message's duration.
	if ((message as any)?.[THINKING_ACTIVE_KEY] || thinkingBlockInFlight) {
		if (evt.type === "text_start" || evt.type === "text_delta" || evt.type === "toolcall_start" || evt.type === "toolcall_end") {
			thinkingBlockInFlight = false;
			const duration = thinkingBlockStartMs > 0 ? Math.max(0, Date.now() - thinkingBlockStartMs) : undefined;
			if (message?.role === "assistant") delete (message as any)[THINKING_ACTIVE_KEY];
			if (typeof duration === "number") {
				lastThinkingBlockDurationMs = duration;
				if (message?.role === "assistant") (message as any)[THINKING_DURATION_KEY] = duration;
			}
		}
	}
}

function registerWorkedTiming(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async () => {
		// Start once per top-level request. Steering/follow-up messages can be
		// injected while the agent is already active; those must not reset the
		// request timer or the turn counter.
		if (currentAgentWorkStartMs === undefined) {
			currentAgentWorkStartMs = Date.now();
			currentRunTurnCount = 0;
		}
		currentAssistantMessageStartMs = undefined;
	});
	pi.on("agent_start", async () => {
		if (currentAgentWorkStartMs === undefined) {
			currentAgentWorkStartMs = Date.now();
			currentRunTurnCount = 0;
		}
		currentAssistantMessageStartMs = undefined;
	});
	pi.on("turn_start", async () => {
		// Count pi's turns for this run rather than how many prompts the user sent.
		if (currentAgentWorkStartMs === undefined) {
			// Hosts that never emit before_agent_start/agent_start: treat the first
			// turn as the run boundary so the counter cannot leak across runs.
			currentAgentWorkStartMs = Date.now();
			currentRunTurnCount = 1;
			return;
		}
		currentRunTurnCount++;
	});
	pi.on("message_start", async (event: any) => {
		const message = event?.message;
		if (message?.role === "user" && currentAgentWorkStartMs === undefined) {
			currentAgentWorkStartMs = Date.now();
			currentRunTurnCount = 0;
		}
		if (message?.role === "assistant") {
			currentAssistantMessageStartMs = Date.now();
			(message as any)[WORKED_START_KEY] = currentAssistantMessageStartMs;
			// A new assistant message starts a fresh thinking lifecycle. Without
			// this, a missing thinking_end on the previous message leaves the
			// in-flight flag set and the next message inherits a stale block.
			thinkingBlockInFlight = false;
			delete (message as any)[THINKING_ACTIVE_KEY];
		}
	});
	pi.on("message_update", async (event: any) => {
		trackThinkingBlockEvents(event);
	});
	pi.on("message_end", async (event: any) => {
		const message = (event as any)?.message;
		if (message?.role === "assistant") {
			// Belt-and-suspenders: if thinking_end never fired (provider skipped
			// it, or the turn ended on toolUse/text), freeze any live block's
			// duration here so it always resolves at the end of the message.
			thinkingBlockInFlight = false;
			delete (message as any)[THINKING_ACTIVE_KEY];
			if (typeof (message as any)[THINKING_DURATION_KEY] !== "number") {
				const duration = thinkingBlockStartMs > 0 ? Math.max(0, Date.now() - thinkingBlockStartMs) : undefined;
				if (typeof duration === "number" && duration > 0) {
					lastThinkingBlockDurationMs = duration;
					(message as any)[THINKING_DURATION_KEY] = duration;
				} else if (typeof lastThinkingBlockDurationMs === "number" && lastThinkingBlockDurationMs > 0) {
					(message as any)[THINKING_DURATION_KEY] = lastThinkingBlockDurationMs;
				}
			}
			thinkingBlockStartMs = 0;
			const started = typeof currentAgentWorkStartMs === "number"
				? currentAgentWorkStartMs
				: typeof (message as any)[WORKED_START_KEY] === "number"
					? (message as any)[WORKED_START_KEY]
					: currentAssistantMessageStartMs;
			const isFinalAssistantMessage = message.stopReason === "stop";
			if (started !== undefined && isFinalAssistantMessage) {
				const durationMs = Math.max(0, Date.now() - started);
				const turns = Math.max(1, currentRunTurnCount);
				sessionWorkedTotalMs += durationMs;
				(message as any)[WORKED_DURATION_KEY] = durationMs;
				(message as any)[WORKED_SESSION_TOTAL_KEY] = sessionWorkedTotalMs;
				(message as any)[WORKED_TURNS_KEY] = turns;
			}
			currentAssistantMessageStartMs = undefined;
		}
	});
	pi.on("agent_end", async () => {
		currentAgentWorkStartMs = undefined;
		currentAssistantMessageStartMs = undefined;
	});
	pi.on("session_start", async (_event, ctx) => {
		// Reset live state on every session transition. Seed from the complete active
		// branch so resume, fork, tree navigation, and compaction retain prior work
		// totals without counting the idle gaps between prompts.
		currentAgentWorkStartMs = undefined;
		currentAssistantMessageStartMs = undefined;
		seedSessionTiming(sessionBranchMessages(ctx) ?? []);
	});
	pi.on("context", async (event, ctx) => {
		const messages = (event as any)?.messages;
		if (!Array.isArray(messages)) return;
		// getBranch() remains complete across compaction; event.messages is a safe
		// fallback for hosts that don't expose a session manager.
		seedSessionTiming(sessionBranchMessages(ctx) ?? messages);
	});
}

// ---------------------------------------------------------------------------
// Tool wrapping: the `activity` parameter
// ---------------------------------------------------------------------------

/** Add the required `activity` param to a tool schema. Returns undefined when the
 *  schema shape can't safely carry it (then the tool is left unwrapped). */
export function withActivityParam(parameters: any): any | undefined {
	if (!parameters || typeof parameters !== "object") return undefined;
	if (parameters.type !== "object" || !parameters.properties || typeof parameters.properties !== "object") return undefined;
	if (parameters.properties[ACTIVITY_PARAM]) return parameters;
	if (Array.isArray(parameters.required) && parameters.required.includes(ACTIVITY_PARAM)) return parameters;
	return {
		...parameters,
		properties: {
			...parameters.properties,
			[ACTIVITY_PARAM]: Type.String({
				description:
					"REQUIRED tag for this call: at most TWO lowercase words naming the current phase. " +
					"NEVER a phrase, sentence, or description — anything over two words is cut off. " +
					"Good: 'exploring', 'implementing', 'fixing-types'. " +
					"Bad: 'checking the streaming usage' (five words). " +
					"Reuse the previous call's label when continuing the same activity.",
				default: DEFAULT_ACTIVITY_LABEL,
			}),
		},
		// Deliberately NOT appended to `required`: the wrapper defaults a missing label
		// in `prepareArguments`, so the tool never actually needs it — and consumers that
		// re-validate arguments against the advertised schema (pi-ptc-next mirrors these
		// parameters for its Python callables) would otherwise reject every call that
		// does not pass a label.
		required: Array.isArray(parameters.required) ? parameters.required : [],
	};
}

export function stripActivityParam(args: any): any {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	if (!(ACTIVITY_PARAM in args)) return args;
	const { [ACTIVITY_PARAM]: _removed, ...rest } = args;
	return rest;
}

/** Wrap a tool definition so the model tags each call with an activity label.
 *  The label lives in the recorded args (survives resume); execution never sees it. */
export function wrapWithActivity(record: any): any {
	if (!record || typeof record !== "object" || record[ACTIVITY_WRAPPED]) return record;
	const parameters = withActivityParam(record.parameters);
	if (!parameters) return record;
	const originalExecute = record.execute;
	const originalPrepare = typeof record.prepareArguments === "function" ? record.prepareArguments : undefined;
	return {
		...record,
		parameters,
		prepareArguments(args: any) {
			const prepared = originalPrepare ? originalPrepare(args) : args;
			const base = prepared && typeof prepared === "object" && !Array.isArray(prepared) ? prepared : {};
			const label = typeof base[ACTIVITY_PARAM] === "string" && base[ACTIVITY_PARAM].trim() ? base[ACTIVITY_PARAM] : DEFAULT_ACTIVITY_LABEL;
			// Return a copy: validation always sees a label, while the recorded
			// tool-call arguments stay exactly what the model sent.
			return { ...base, [ACTIVITY_PARAM]: label };
		},
		async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
			return originalExecute(toolCallId, stripActivityParam(params), signal, onUpdate, ctx);
		},
		[ACTIVITY_WRAPPED]: true,
	};
}

// ---------------------------------------------------------------------------
// Native tool labeling (never replaces another extension's tool definition)
// ---------------------------------------------------------------------------

function registerBuiltinActivityTools(pi: ExtensionAPI): void {
	const factories: Record<string, (cwd: string) => any> = {
		read: createReadToolDefinition,
		bash: createBashToolDefinition,
		edit: createEditToolDefinition,
		write: createWriteToolDefinition,
		grep: createGrepToolDefinition,
		find: createFindToolDefinition,
		ls: createLsToolDefinition,
	};
	// At session_start all extensions have registered their tools. Only decorate
	// definitions still owned by pi itself; never clobber a custom renderer,
	// permission wrapper, or alternate implementation registered by a plugin.
	pi.on("session_start", async (_event, ctx) => {
		if (!toolActivityParamEnabled()) return;
		const tools = pi.getAllTools();
		const active = pi.getActiveTools();
		let changed = false;
		for (const info of tools) {
			const factory = factories[info.name];
			if (!factory || info.sourceInfo?.source !== "builtin") continue;
			const definition = factory(ctx.cwd);
			pi.registerTool(wrapWithActivity({
				...definition,
				execute(id: string, params: any, signal: any, onUpdate: any, toolCtx: any) {
					// Session switches can change cwd without reloading this extension.
					return factory(toolCtx?.cwd ?? ctx.cwd).execute(id, params, signal, onUpdate, toolCtx);
				},
			}));
			changed = true;
		}
		// Registration activates tools by default. Do not enable optional built-ins
		// or alter the user's selected loadout just to add a schema property.
		if (changed) pi.setActiveTools(active);
	});
}

// ---------------------------------------------------------------------------
// Activity tracking: types
// ---------------------------------------------------------------------------

/**
 * Public API for other extensions: the opt-in activity-label hook plus a
 * read-only view of what the session is doing.
 *
 * A plugin opts in by wrapping its own definition before registering it:
 *
 *   const activity = (globalThis as any)[Symbol.for("pi-activity:api")];
 *   pi.registerTool(activity?.wrapTool ? activity.wrapTool(tool) : tool);
 *
 * `wrapTool` is a no-op when the `toolActivityParam` setting is off, so plugins
 * can call it unconditionally.
 *
 * The same object answers what the session is doing right now (`getActivity`),
 * what it has done so far (`getStats`), and when either changes (`subscribe`).
 * State is fed by pi's own events rather than by the transcript renderer, so it
 * is correct in hosts that never paint the grouped rows (RPC, headless, tests)
 * and never depends on a component being on screen. Durations are measured to
 * the moment a getter or listener runs, so a status line can poll them on its
 * own repaint cadence. Full reference: API.md.
 */
/** Canonical key for this package. The legacy `pi-tool-tree` keys resolve to the
 *  same object, so plugins written against pi-tool-tree keep working when it is
 *  absent. When both extensions are loaded, load order decides which object sits
 *  under the legacy `pi-tool-tree:api` key — every consumer of that key only
 *  needs the activity methods, which both objects provide. */
const PI_ACTIVITY_API_KEY = Symbol.for("pi-activity:api");
const TOOL_TREE_API_KEY = Symbol.for("pi-tool-tree:api");
/**
 * Opt-in integration key other tool plugins use to apply the activity param.
 * Kept for plugins written before the query API existed; it resolves to the same
 * object as `PI_ACTIVITY_API_KEY`.
 */
const ACTIVITY_API_KEY = Symbol.for("pi-tool-tree:activity-api");

/** What the agent is doing. `idle` has no run in flight; `waiting` has one but
 *  nothing is streaming (awaiting the model, or between calls). */
export type ActivityPhase = "idle" | "waiting" | "thinking" | "responding" | "tool";

/** A tool call that is executing right now. */
export interface ActivityRunningCall {
	toolCallId: string;
	toolName: string;
	/** Activity label in effect when the call started. */
	label: string;
	/** Short single-line preview of the call's first meaningful argument,
	 *  for external consumers like the PTC subagent viewer. */
	argPreview?: string;
	/** Epoch milliseconds. */
	startedAt: number;
	/** Milliseconds this call has been running, measured to this call. */
	elapsedMs: number;
}

/** Counters for the current agent run. All zero while idle. */
export interface ActivityRunStats {
	startedAt: number | null;
	/** Wall time since the run started. */
	elapsedMs: number;
	turns: number;
	/** Calls started in this run, including the ones still running. */
	toolCalls: number;
	toolCallsRunning: number;
	toolCallsFailed: number;
	/** Summed call spans, including running calls measured to this call. Parallel
	 *  calls each contribute their own span, so this can exceed the run's wall time. */
	toolMs: number;
	/** Summed reasoning time, including a block that is still streaming. */
	thinkingMs: number;
}

/** A point-in-time answer to "what is happening right now". */
export interface ActivitySnapshot {
	phase: ActivityPhase;
	/** A run is in flight (equivalent to `phase !== "idle"`). */
	isWorking: boolean;
	/** Reasoning is streaming right now. */
	isThinking: boolean;
	/** At least one tool call is executing right now. */
	isRunningTool: boolean;
	/** Model-declared activity label for the current phase, e.g. "implementing".
	 *  Never null while working: a phase the model has not named yet reports
	 *  `defaultLabel`, and unlabeled calls inherit the previous label. */
	label: string | null;
	/** When the current label took effect. */
	labelStartedAt: number | null;
	/** Wall time spent on the current label, measured to this call. */
	labelElapsedMs: number;
	/** Calls started under the current label. */
	labelCalls: number;
	/** Start of the reasoning block that is streaming, or null. */
	thinkingStartedAt: number | null;
	thinkingElapsedMs: number;
	/** Calls executing right now, in start order. */
	calls: ActivityRunningCall[];
	run: ActivityRunStats;
}

export interface ActivityToolStat {
	calls: number;
	failed: number;
	/** Milliseconds; only measured for calls made in this process. */
	durationMs: number;
}

export interface ActivityLabelStat {
	calls: number;
	durationMs: number;
}

/** Cumulative statistics since the session began (resumed history included). */
export interface ActivitySessionStats {
	/** Completed agent work: the sum of finished runs, idle time excluded. This is
	 *  the same number the transcript's `Total time` reports. */
	workedMs: number;
	runs: number;
	/** Turns across the finished runs of this session. */
	turns: number;
	/** Calls that finished, in this session and in resumed history. */
	toolCalls: number;
	toolCallsFailed: number;
	toolMs: number;
	thinkingMs: number;
	thinkingBlocks: number;
	byTool: Record<string, ActivityToolStat>;
	byLabel: Record<string, ActivityLabelStat>;
}

export type ActivityChangeType =
	| "run-start"
	| "turn-start"
	| "label-change"
	| "thinking-start"
	| "thinking-end"
	| "stream-start"
	| "stream-end"
	| "tool-start"
	| "tool-end"
	| "run-end";

/** What changed, delivered alongside the resulting snapshot. */
export interface ActivityChange {
	type: ActivityChangeType;
	toolCallId?: string;
	toolName?: string;
	/** Set on `label-change` and `tool-start`. */
	label?: string;
	/** Set on `tool-start`: one-line preview of the call's first argument. */
	argPreview?: string;
	/** Set on `tool-end`. */
	isError?: boolean;
	/** Set on `thinking-end`, `tool-end`, and `run-end`. */
	durationMs?: number;
	/** Set on `run-end`: the run that just finished. The snapshot is already idle,
	 *  so this is where a finished run's totals stay readable. */
	run?: ActivityRunStats;
}

export type ActivityListener = (activity: ActivitySnapshot, change: ActivityChange) => void;

export interface ActivityApi {
	/** Integration contract version for `wrapTool`. The query methods are
	 *  additive, so feature-detect them instead of branching on this. */
	version: 1;
	param: string;
	defaultLabel: string;
	enabled(): boolean;
	wrapTool<T extends object>(tool: T): T;
	getActivity(): ActivitySnapshot;
	getStats(): ActivitySessionStats;
	subscribe(listener: ActivityListener): () => void;
	/** The transcript's own duration formatting (`<1s`, `12s`, `3m 05s`, `1h 02m`). */
	formatDuration(ms: number): string;
	/**
	 * Paint `text` with the live activity label's shimmer: the same highlight band,
	 * cosine falloff and thinking-level color the grouped transcript sweeps across a
	 * running group's label. `theme` optionally adopts the caller's theme, so callers
	 * that render outside this extension's transcript still track the active palette.
	 * Time-phased: repaint on `shimmerIntervalMs` and the band advances on its own.
	 */
	shimmerText(text: string, theme?: unknown): string;
	/** The repaint cadence the label sweep expects (see `shimmerText`). */
	readonly shimmerIntervalMs: number;
}

interface ActivityCallState {
	toolCallId: string;
	toolName: string;
	label: string;
	startedAt: number;
	argPreview?: string;
}

// ---------------------------------------------------------------------------
// Activity tracking: state and lifecycle
// ---------------------------------------------------------------------------

const activityState = {
	/** Start of the run in flight, or null while idle. */
	runStartedAt: null as number | null,
	turns: 0,
	label: null as string | null,
	labelStartedAt: null as number | null,
	labelCalls: 0,
	/** Start of the reasoning block streaming right now, or null. */
	thinkingStartedAt: null as number | null,
	/** Reasoning finished within this run. */
	thinkingMs: 0,
	/** The model is streaming output right now (answer text or call arguments). */
	streaming: false,
	calls: new Map<string, ActivityCallState>(),
	toolCalls: 0,
	toolFailures: 0,
	toolMs: 0,
	listeners: new Set<ActivityListener>(),
	session: {
		runs: 0,
		turns: 0,
		toolCalls: 0,
		toolCallsFailed: 0,
		toolMs: 0,
		thinkingMs: 0,
		thinkingBlocks: 0,
		byTool: {} as Record<string, ActivityToolStat>,
		byLabel: {} as Record<string, ActivityLabelStat>,
	},
};

function bumpActivityToolStat(stats: Record<string, ActivityToolStat>, key: string, durationMs: number, failed: boolean): void {
	const entry = stats[key] ?? (stats[key] = { calls: 0, failed: 0, durationMs: 0 });
	entry.calls++;
	if (failed) entry.failed++;
	entry.durationMs += Math.max(0, durationMs);
}

function bumpActivityLabelStat(stats: Record<string, ActivityLabelStat>, key: string, durationMs: number): void {
	const entry = stats[key] ?? (stats[key] = { calls: 0, durationMs: 0 });
	entry.calls++;
	entry.durationMs += Math.max(0, durationMs);
}

function activityRunStats(now: number): ActivityRunStats {
	const started = activityState.runStartedAt;
	let liveToolMs = 0;
	for (const call of activityState.calls.values()) liveToolMs += Math.max(0, now - call.startedAt);
	const liveThinkingMs = activityState.thinkingStartedAt === null ? 0 : Math.max(0, now - activityState.thinkingStartedAt);
	return {
		startedAt: started,
		elapsedMs: started === null ? 0 : Math.max(0, now - started),
		turns: activityState.turns,
		toolCalls: activityState.toolCalls,
		toolCallsRunning: activityState.calls.size,
		toolCallsFailed: activityState.toolFailures,
		toolMs: activityState.toolMs + liveToolMs,
		thinkingMs: activityState.thinkingMs + liveThinkingMs,
	};
}

function activitySnapshot(): ActivitySnapshot {
	const now = Date.now();
	const calls = [...activityState.calls.values()].map((call) => ({
		toolCallId: call.toolCallId,
		toolName: call.toolName,
		label: call.label,
		startedAt: call.startedAt,
		elapsedMs: Math.max(0, now - call.startedAt),
	}));
	const thinking = activityState.thinkingStartedAt !== null;
	const phase: ActivityPhase = activityState.runStartedAt === null
		? "idle"
		: calls.length > 0
			? "tool"
			: thinking
				? "thinking"
				: activityState.streaming
					? "responding"
					: "waiting";
	return {
		phase,
		isWorking: activityState.runStartedAt !== null,
		isThinking: thinking,
		isRunningTool: calls.length > 0,
		label: activityState.label,
		labelStartedAt: activityState.labelStartedAt,
		labelElapsedMs: activityState.labelStartedAt === null ? 0 : Math.max(0, now - activityState.labelStartedAt),
		labelCalls: activityState.labelCalls,
		thinkingStartedAt: activityState.thinkingStartedAt,
		thinkingElapsedMs: thinking ? Math.max(0, now - (activityState.thinkingStartedAt as number)) : 0,
		calls,
		run: activityRunStats(now),
	};
}

function activitySessionStats(): ActivitySessionStats {
	const session = activityState.session;
	const byTool: Record<string, ActivityToolStat> = {};
	for (const [name, stat] of Object.entries(session.byTool)) byTool[name] = { ...stat };
	const byLabel: Record<string, ActivityLabelStat> = {};
	for (const [label, stat] of Object.entries(session.byLabel)) byLabel[label] = { ...stat };
	return {
		workedMs: Math.max(0, sessionWorkedTotalMs),
		runs: session.runs,
		turns: session.turns,
		toolCalls: session.toolCalls,
		toolCallsFailed: session.toolCallsFailed,
		toolMs: session.toolMs,
		thinkingMs: session.thinkingMs,
		thinkingBlocks: session.thinkingBlocks,
		byTool,
		byLabel,
	};
}

/** Tell subscribers what changed. The snapshot is built once per change and
 *  never handed out live, so listeners cannot corrupt tracked state — and a
 *  throwing listener must never take the agent down, so each call is guarded. */
function emitActivityChange(type: ActivityChangeType, detail: Omit<ActivityChange, "type"> = {}): void {
	if (activityState.listeners.size === 0) return;
	const activity = activitySnapshot();
	const change: ActivityChange = { type, ...detail };
	for (const listener of [...activityState.listeners]) {
		try {
			listener(activity, change);
		} catch { /* noop */ }
	}
}

/** A run is one prompt-to-answer cycle; `agent_end` closes it. Guarded so the
 *  `before_agent_start` / `agent_start` pair and steering injections (which can
 *  re-fire while the agent is busy) do not reset a run mid-flight. */
function activityStartRun(): void {
	if (activityState.runStartedAt !== null) return;
	const now = Date.now();
	activityState.runStartedAt = now;
	activityState.turns = 0;
	// Nothing has named this phase yet; the transcript's own fallback is `working`.
	activityState.label = DEFAULT_ACTIVITY_LABEL;
	activityState.labelStartedAt = now;
	activityState.labelCalls = 0;
	activityState.thinkingStartedAt = null;
	activityState.thinkingMs = 0;
	activityState.streaming = false;
	activityState.calls.clear();
	activityState.toolCalls = 0;
	activityState.toolFailures = 0;
	activityState.toolMs = 0;
	emitActivityChange("run-start");
}

function activityStartTurn(): void {
	if (activityState.runStartedAt === null) {
		// Hosts that never emit agent_start: the first turn is the run boundary.
		activityStartRun();
		activityState.turns = 1;
	} else {
		activityState.turns++;
	}
	emitActivityChange("turn-start");
}

function activityStartThinking(): void {
	if (activityState.thinkingStartedAt !== null) return;
	activityState.thinkingStartedAt = Date.now();
	emitActivityChange("thinking-start");
}

function activityEndThinking(): void {
	const started = activityState.thinkingStartedAt;
	if (started === null) return;
	const durationMs = Math.max(0, Date.now() - started);
	activityState.thinkingStartedAt = null;
	activityState.thinkingMs += durationMs;
	activityState.session.thinkingMs += durationMs;
	activityState.session.thinkingBlocks++;
	emitActivityChange("thinking-end", { durationMs });
}

function activityStartStreaming(): void {
	if (activityState.streaming) return;
	activityState.streaming = true;
	emitActivityChange("stream-start");
}

function activityEndStreaming(): void {
	if (!activityState.streaming) return;
	activityState.streaming = false;
	emitActivityChange("stream-end");
}

/** Reasoning streams from `thinking_start` to `thinking_end`, but some providers
 *  skip the end (or the start) marker. Any other stream event on the same
 *  message means reasoning is over, and a delta with no start means it began. */
function activityMessageUpdate(event: any): void {
	const evt = event?.assistantMessageEvent;
	const message = event?.message;
	if (!evt || typeof evt.type !== "string") return;
	if (message && typeof message === "object" && message.role !== "assistant") return;
	switch (evt.type) {
		case "thinking_start":
			activityStartThinking();
			return;
		case "thinking_delta":
			activityStartThinking();
			return;
		case "thinking_end":
			activityEndThinking();
			return;
		case "text_start":
		case "text_delta":
		case "toolcall_start":
		case "toolcall_delta":
			// Model output means reasoning is over, even without a thinking_end.
			activityEndThinking();
			activityStartStreaming();
			return;
		case "text_end":
		case "toolcall_end":
			activityEndStreaming();
			return;
		default:
			return;
	}
}

/** A new assistant message owns a fresh thinking/streaming lifecycle; a missing
 *  end marker on the previous one must not leak a phase into this one. */
function activityMessageStart(event: any): void {
	const message = event?.message;
	if (message && typeof message === "object" && message.role !== "assistant") return;
	activityEndThinking();
	activityEndStreaming();
}

function activityMessageEnd(event: any): void {
	const message = event?.message;
	if (message && typeof message === "object" && message.role !== "assistant") return;
	activityEndThinking();
	activityEndStreaming();
}

/** Resolve the phase label for a call: what the model declared, else the label
 *  already in effect (unlabeled calls continue the current group), else the
 *  transcript's fallback label. */
function activityResolveLabel(args: any): string {
	const declared = normalizeActivityLabel(args?.[ACTIVITY_PARAM]);
	if (declared) return declared;
	return activityState.label ?? DEFAULT_ACTIVITY_LABEL;
}

function activityToolStart(event: any): void {
	const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
	if (!toolCallId) return;
	// A call can only happen inside a run, but be forgiving: an extension loaded
	// mid-run (or a replayed event) should still report the call.
	if (activityState.runStartedAt === null) activityStartRun();
	const now = Date.now();
	const label = activityResolveLabel(event?.args);
	if (label !== activityState.label) {
		activityState.label = label;
		activityState.labelStartedAt = now;
		activityState.labelCalls = 0;
		emitActivityChange("label-change", { label });
	}
	activityState.labelCalls++;
	activityState.toolCalls++;
	const toolName = typeof event?.toolName === "string" && event.toolName ? event.toolName : "tool";
	const argPreview = activityArgPreview(event?.args);
	activityState.calls.set(toolCallId, { toolCallId, toolName, label, startedAt: now, argPreview });
	emitActivityChange("tool-start", { toolCallId, toolName, label, argPreview });
}

/** One-line preview of a tool call's arguments for external activity
 *  consumers: the first meaningful string argument, whitespace-flattened and
 *  trimmed. Never throws; undefined when nothing previewable is available. */
function activityArgPreview(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	try {
		for (const value of Object.values(args as Record<string, unknown>)) {
			if (typeof value === "string" && value.trim()) {
				const flat = value.replace(/\s+/g, " ").trim();
				return flat.length > 64 ? `${flat.slice(0, 61)}...` : flat;
			}
		}
	} catch {
		// preview is best-effort
	}
	return undefined;
}

function activityToolEnd(event: any): void {
	const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
	const call = toolCallId ? activityState.calls.get(toolCallId) : undefined;
	const isError = event?.isError === true;
	const toolName = call?.toolName
		?? (typeof event?.toolName === "string" && event.toolName ? event.toolName : "tool");
	const label = call?.label ?? activityState.label ?? DEFAULT_ACTIVITY_LABEL;
	const durationMs = call ? Math.max(0, Date.now() - call.startedAt) : 0;
	if (toolCallId) activityState.calls.delete(toolCallId);
	activityState.toolMs += durationMs;
	if (isError) activityState.toolFailures++;
	const session = activityState.session;
	session.toolCalls++;
	if (isError) session.toolCallsFailed++;
	session.toolMs += durationMs;
	bumpActivityToolStat(session.byTool, toolName, durationMs, isError);
	bumpActivityLabelStat(session.byLabel, label, durationMs);
	emitActivityChange("tool-end", { toolCallId, toolName, isError, durationMs });
}

function activityEndRun(): void {
	if (activityState.runStartedAt === null) return;
	// A call still in flight when the run ends never produced a result; settle it
	// as a failure so it is counted rather than silently dropped.
	for (const call of [...activityState.calls.values()]) {
		activityToolEnd({ toolCallId: call.toolCallId, toolName: call.toolName, isError: true });
	}
	activityEndThinking();
	activityEndStreaming();
	const run = activityRunStats(Date.now());
	activityState.session.runs++;
	activityState.session.turns += run.turns;
	activityState.runStartedAt = null;
	activityState.turns = 0;
	activityState.label = null;
	activityState.labelStartedAt = null;
	activityState.labelCalls = 0;
	activityState.toolCalls = 0;
	activityState.toolFailures = 0;
	activityState.toolMs = 0;
	activityState.thinkingMs = 0;
	emitActivityChange("run-end", { durationMs: run.elapsedMs, run });
}

/** Counters survive resume/reload: walked back from the active branch so
 *  `getStats()` reports the whole session, not just this process. Durations of
 *  calls made before this process start are unknown (they were never recorded),
 *  so call counts are seeded while call time is not; reasoning time is, because
 *  completed thinking blocks stamp their duration into the message. */
function seedActivitySession(messages: any[]): void {
	const session = activityState.session;
	session.runs = 0;
	session.turns = 0;
	session.toolCalls = 0;
	session.toolCallsFailed = 0;
	session.toolMs = 0;
	session.thinkingMs = 0;
	session.thinkingBlocks = 0;
	session.byTool = {};
	session.byLabel = {};
	// Calls are counted from the assistant's own `toolCall` blocks; a failed
	// `toolResult` marks that call as failed rather than counting a second call.
	const countedCalls = new Set<string>();
	let runTurns = 0;
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if (message.role === "user") {
			runTurns = 0;
			continue;
		}
		if (message.role === "toolResult") {
			if (message.isError !== true) continue;
			session.toolCallsFailed++;
			const failedTool = typeof message.toolName === "string" && message.toolName ? message.toolName : "tool";
			const entry = session.byTool[failedTool] ?? (session.byTool[failedTool] = { calls: 0, failed: 0, durationMs: 0 });
			entry.failed++;
			// A result whose call is not in the branch (compacted or edited history)
			// still stands for a call that happened.
			const resultCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
			if (!resultCallId || !countedCalls.has(resultCallId)) entry.calls++;
			continue;
		}
		if (message.role !== "assistant") continue;
		runTurns++;
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "toolCall") {
				session.toolCalls++;
				if (typeof block.id === "string" && block.id) countedCalls.add(block.id);
				bumpActivityToolStat(session.byTool, typeof block.name === "string" && block.name ? block.name : "tool", 0, false);
				bumpActivityLabelStat(session.byLabel, normalizeActivityLabel(block.arguments?.[ACTIVITY_PARAM]) || DEFAULT_ACTIVITY_LABEL, 0);
				continue;
			}
			if (block.type !== "thinking") continue;
			const durationMs = message[THINKING_DURATION_KEY];
			if (typeof durationMs !== "number" || !(durationMs > 0)) continue;
			session.thinkingMs += durationMs;
			session.thinkingBlocks++;
		}
		if (message.stopReason !== "stop") continue;
		if (typeof message[WORKED_DURATION_KEY] !== "number") continue;
		session.runs++;
		const stamped = message[WORKED_TURNS_KEY];
		session.turns += typeof stamped === "number" && stamped > 0 ? stamped : runTurns;
	}
}

function activityResetRun(): void {
	activityState.runStartedAt = null;
	activityState.turns = 0;
	activityState.label = null;
	activityState.labelStartedAt = null;
	activityState.labelCalls = 0;
	activityState.thinkingStartedAt = null;
	activityState.thinkingMs = 0;
	activityState.streaming = false;
	activityState.calls.clear();
	activityState.toolCalls = 0;
	activityState.toolFailures = 0;
	activityState.toolMs = 0;
}

function activitySubscribe(listener: ActivityListener): () => void {
	if (typeof listener !== "function") return () => {};
	activityState.listeners.add(listener);
	let subscribed = true;
	return () => {
		if (!subscribed) return;
		subscribed = false;
		activityState.listeners.delete(listener);
	};
}

function publishActivityApi(): void {
	const api: ActivityApi = {
		version: 1,
		param: ACTIVITY_PARAM,
		defaultLabel: DEFAULT_ACTIVITY_LABEL,
		enabled: toolActivityParamEnabled,
		wrapTool: <T extends object>(tool: T): T => (toolActivityParamEnabled() ? (wrapWithActivity(tool as any) as T) : tool),
		getActivity: activitySnapshot,
		getStats: activitySessionStats,
		subscribe: activitySubscribe,
		formatDuration: formatBashDuration,
		// The label sweep as a public painter, so another surface that wants the same
		// animation (the PTC subagent panel) does not have to re-implement a cheaper
		// approximation of it — which is what read as a hard-edged band next to this one.
		shimmerText: (text: string, shimmerTheme?: unknown): string => {
			if (shimmerTheme) _toolBranchThemeHint = shimmerTheme as Theme | undefined;
			return shimmerTextAnsi(text);
		},
		shimmerIntervalMs: SHIMMER_INTERVAL_MS,
	};
	// One object, three keys: this package's canonical name plus the two legacy
	// `pi-tool-tree` names, so plugins written against any of them share the same
	// state and subscriptions. When pi-tool-tree is also loaded, load order
	// decides which object sits under the legacy keys; every consumer of those
	// keys only needs the activity methods, which both objects provide.
	(globalThis as any)[PI_ACTIVITY_API_KEY] = api;
	(globalThis as any)[TOOL_TREE_API_KEY] = api;
	(globalThis as any)[ACTIVITY_API_KEY] = api;
}

/** Feed the tracker from pi's events and publish the API. Registered early so
 *  the object is in place before any tool registers or a run starts. */
function registerActivityApi(pi: ExtensionAPI): void {
	publishActivityApi();
	pi.on("before_agent_start", async () => { activityStartRun(); });
	pi.on("agent_start", async () => { activityStartRun(); });
	pi.on("turn_start", async () => { activityStartTurn(); });
	pi.on("message_start", async (event) => { activityMessageStart(event); });
	pi.on("message_update", async (event) => { activityMessageUpdate(event); });
	pi.on("message_end", async (event) => { activityMessageEnd(event); });
	pi.on("tool_execution_start", async (event) => { activityToolStart(event); });
	pi.on("tool_execution_end", async (event) => { activityToolEnd(event); });
	pi.on("agent_end", async () => { activityEndRun(); });
	// Rebuild counters from the active branch on resume/reload/fork, the same way
	// the transcript re-seeds its work totals.
	pi.on("session_start", async (_event, ctx) => {
		activityResetRun();
		// Adopt the active theme so shimmer colors track it even when nothing
		// passes a theme to `shimmerText` (pi-tool-tree does on every render).
		const theme = (ctx as any)?.ui?.theme;
		if (theme) _toolBranchThemeHint = theme;
		const messages = sessionBranchMessages(ctx);
		if (messages) seedActivitySession(messages);
	});
	pi.on("session_shutdown", async () => {
		activityResetRun();
		activityState.listeners.clear();
	});
}

// ---------------------------------------------------------------------------
// Shimmer: the label sweep painter
// ---------------------------------------------------------------------------

/**
 * Running group labels sweep a highlight band across the text (the Claude Code /
 * ChatGPT "working" shimmer). Time-based rather than frame-based so the motion is
 * uniform no matter how often the TUI re-renders.
 *
 * The band's color is the active theme's color for the *current thinking level*, so a live
 * label is tinted by how hard the model is being asked to think and follows /thinking,
 * Shift+Tab, and model switches. The level color is used as-is: pushing it toward the
 * panel's emphasis color costs the chroma that makes it read as a palette color.
 */
const SHIMMER_PERIOD_MS = 1800;
/** Re-render cadence while a shimmering group is on screen (the ● blink stays 500ms). */
export const SHIMMER_INTERVAL_MS = 80;
/** Highlight band half-width, as a fraction of the label length. */
const SHIMMER_BAND_RATIO = 0.65;
/** Mix toward the band color at the band's center: the level color itself. */
const SHIMMER_PEAK_MIX = 1;
/** Exponent on the cosine falloff; >1 keeps the tint in a hot core instead of a wash. */
const SHIMMER_FALLOFF_POW = 1.5;
/**
 * Minimum distance between the band and the label's own color. A muted level (or a level
 * color close to the theme's text) left the band indistinguishable from the label, so the
 * "sweep" read as a static word — the band always steps away from the label to keep at
 * least this much separation.
 */
const SHIMMER_MIN_BAND_DELTA = 72;
/** Pi thinking level -> theme color key (the same mapping pi uses for thinking borders). */
const THINKING_LEVEL_KEYS: Record<string, string> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};
/** `max` arrived after the other levels; older themes only define `thinkingXhigh`. */
const THINKING_LEVEL_COLOR_FALLBACKS: Record<string, string[]> = { max: ["thinkingXhigh"] };
/** Band color when no thinking level is known, or the theme has no color for it. */
const SHIMMER_FALLBACK_KEYS = ["accent", "borderAccent", "mdLink"];
/** How far the band color must sit from the label to read as a sweep at all. */
const SHIMMER_MIN_SWEEP_DELTA = 40;
/** pi's muted levels can match the panel color ("off"); the band needs at least this much. */
const SHIMMER_MIN_CONTRAST = 1.6;
/** Current pi thinking level, as reported by the session runtime. */
let _thinkingLevel: string | undefined;
/** Label base color when the active theme exposes no `text`/`muted` key. */
const DEFAULT_LABEL_FG = "\x1b[38;2;212;212;212m";
/** The active pi theme, adopted from `shimmerText(theme)` / `session_start`, so
 *  shimmer colors track the user's palette without a renderer driving it. */
let _toolBranchThemeHint: any;

// 6x6x6 color cube channel values used by pi's 256color fallback.
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

function xterm256ToRgb(index: number): { r: number; g: number; b: number } | null {
	if (!Number.isInteger(index) || index < 0 || index > 255) return null;
	if (index < 16) {
		// Standard 16 ANSI colors — terminal-defined, approximate with VS Code defaults.
		const basic: Array<[number, number, number]> = [
			[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
			[0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
			[128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
			[0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
		];
		const [r, g, b] = basic[index];
		return { r, g, b };
	}
	if (index < 232) {
		const i = index - 16;
		return {
			r: CUBE_VALUES[Math.floor(i / 36) % 6],
			g: CUBE_VALUES[Math.floor(i / 6) % 6],
			b: CUBE_VALUES[i % 6],
		};
	}
	const level = 8 + (index - 232) * 10;
	return { r: level, g: level, b: level };
}

function parseAnsiRgb(ansi: string): { r: number; g: number; b: number } | null {
	if (!ansi) return null;
	const esc = "\u001b";
	// Truecolor: \e[38;2;R;G;Bm or \e[48;2;R;G;Bm
	const tc = ansi.match(new RegExp(`${esc}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
	if (tc) return { r: +tc[1], g: +tc[2], b: +tc[3] };
	// 256-color: \e[38;5;Nm or \e[48;5;Nm — happens on Apple Terminal, screen, etc.
	const idx = ansi.match(new RegExp(`${esc}\\[(?:38|48);5;(\\d+)m`));
	if (idx) return xterm256ToRgb(+idx[1]);
	return null;
}

// ---------------------------------------------------------------------------
// Theme palette extraction — pull RGB from the active pi theme so shimmer
// colors track the user's selected theme.
//
// `theme.getFgAnsi(name)` / `theme.getBgAnsi(name)` return raw ANSI escapes
// (either truecolor or 256color depending on the terminal). We parse those
// back into RGB so we can mix tints for the sweep band.
// ---------------------------------------------------------------------------

type Rgb = { r: number; g: number; b: number };

function safeFgAnsi(theme: any, key: string): string | null {
	try {
		const ansi = theme?.getFgAnsi?.(key);
		return typeof ansi === "string" && ansi.length > 0 ? ansi : null;
	} catch {
		return null;
	}
}

function safeBgAnsi(theme: any, key: string): string | null {
	try {
		const ansi = theme?.getBgAnsi?.(key);
		return typeof ansi === "string" && ansi.length > 0 ? ansi : null;
	} catch {
		return null;
	}
}

function themeFgRgb(theme: any, key: string): Rgb | null {
	const ansi = safeFgAnsi(theme, key);
	return ansi ? parseAnsiRgb(ansi) : null;
}

function themeBgRgb(theme: any, key: string): Rgb | null {
	const ansi = safeBgAnsi(theme, key);
	return ansi ? parseAnsiRgb(ansi) : null;
}

/** Panel background the label sits on, when the theme exposes one. */
function themePanelBgRgb(theme: any): Rgb | null {
	return (
		themeBgRgb(theme, "toolSuccessBg") ||
		themeBgRgb(theme, "userMessageBg") ||
		themeBgRgb(theme, "selectedBg")
	);
}

function isLightThemeBackground(theme: any): boolean {
	const panel = themePanelBgRgb(theme);
	if (panel) {
		const lum = 0.2126 * panel.r + 0.7152 * panel.g + 0.0722 * panel.b;
		return lum > 165;
	}
	const fg = themeFgRgb(theme, "text") || themeFgRgb(theme, "fg");
	if (fg) {
		const lum = 0.2126 * fg.r + 0.7152 * fg.g + 0.0722 * fg.b;
		return lum < 95;
	}
	return false;
}

function mixRgb(
	a: { r: number; g: number; b: number },
	b: { r: number; g: number; b: number },
	ratio: number,
): { r: number; g: number; b: number } {
	return {
		r: a.r + (b.r - a.r) * ratio,
		g: a.g + (b.g - a.g) * ratio,
		b: a.b + (b.b - a.b) * ratio,
	};
}

/**
 * Base color for a shimmering activity label: the theme's primary text color. The sweep
 * runs from here to the band color, so a live label reads as the theme's own text lit up by
 * the palette's current thinking-level color.
 */
function shimmerBaseRgb(): Rgb {
	if (themeAdaptiveEnabled()) {
		const ansi =
			safeFgAnsi(_toolBranchThemeHint, "text") ?? safeFgAnsi(_toolBranchThemeHint, "muted");
		const rgb = ansi ? parseAnsiRgb(ansi) : null;
		if (rgb) return rgb;
	}
	return parseAnsiRgb(DEFAULT_LABEL_FG) ?? { r: 212, g: 212, b: 212 };
}

function rgbDistance(a: Rgb, b: Rgb): number {
	return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/** W3C relative luminance, for contrast checks against the panel. */
function relativeLuminance(c: Rgb): number {
	const channel = (value: number) => {
		const v = value / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** W3C contrast ratio between two colors. */
function contrastRatio(a: Rgb, b: Rgb): number {
	const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * The color the band peaks at: the active theme's color for the current thinking level, so
 * the sweep tracks /thinking, Shift+Tab, and model switches. A theme with no color for that
 * level falls back to its accent, and so does a context that never reported a level.
 */
function shimmerSweepRgb(): Rgb | null {
	if (!themeAdaptiveEnabled()) return null;
	const level = _thinkingLevel;
	const key = level ? THINKING_LEVEL_KEYS[level] : undefined;
	const keys = [
		...(key ? [key, ...(THINKING_LEVEL_COLOR_FALLBACKS[level as string] ?? [])] : []),
		...SHIMMER_FALLBACK_KEYS,
	];
	for (const candidate of keys) {
		const rgb = themeFgRgb(_toolBranchThemeHint, candidate);
		if (rgb) return rgb;
	}
	return null;
}

/**
 * Keep a level's color visible on the panel. Pi's muted levels sit close to the panel color
 * ("off" is usually a surface tone) and would sweep invisibly, so those step toward the
 * panel's emphasis color. A loud level is returned untouched: its chroma is the point.
 */
function readableOnPanel(rgb: Rgb, panel: Rgb | null, light: boolean): Rgb {
	if (!panel) return rgb;
	if (contrastRatio(rgb, panel) >= SHIMMER_MIN_CONTRAST) return rgb;
	const target = light ? { r: 12, g: 16, b: 18 } : { r: 255, g: 255, b: 255 };
	for (const push of [0.25, 0.45, 0.65]) {
		const candidate = mixRgb(rgb, target, push);
		if (contrastRatio(candidate, panel) >= SHIMMER_MIN_CONTRAST) return candidate;
	}
	return mixRgb(rgb, target, 0.65);
}

/**
 * The band's hot color: the current thinking level's theme color, kept visible against the
 * panel. With no level color — or one indistinguishable from the label — the sweep steps
 * away from the label instead: brighten on dark panels, deepen on light ones.
 */
function shimmerHighlightRgb(base: Rgb): Rgb {
	const light = isLightThemeBackground(_toolBranchThemeHint);
	const sweep = shimmerSweepRgb();
	const band = sweep && rgbDistance(base, sweep) >= SHIMMER_MIN_SWEEP_DELTA
		? readableOnPanel(sweep, themePanelBgRgb(_toolBranchThemeHint), light)
		: light
			? mixRgb(base, { r: 12, g: 16, b: 18 }, 0.75)
			: mixRgb(base, { r: 255, g: 255, b: 255 }, 0.92);
	return ensureBandContrast(base, band, light);
}

/**
 * Keep the band visibly different from the label's own color. A muted thinking level can
 * land close to the theme's text color, which left the sweep looking like a static word;
 * step the band away from the label until it separates.
 */
function ensureBandContrast(base: Rgb, band: Rgb, light: boolean): Rgb {
	if (rgbDistance(base, band) >= SHIMMER_MIN_BAND_DELTA) return band;
	const away = light ? { r: 12, g: 16, b: 18 } : { r: 255, g: 255, b: 255 };
	let out = band;
	for (const push of [0.3, 0.5, 0.7, 0.85]) {
		out = mixRgb(band, away, push);
		if (rgbDistance(base, out) >= SHIMMER_MIN_BAND_DELTA) return out;
	}
	return out;
}

/**
 * Paint `text` with a highlight band part-way across it. The band travels left to
 * right and wraps, so every re-render of a running group advances the wave.
 */
function shimmerTextAnsi(text: string): string {
	const length = text.length;
	if (length === 0) return "";
	const base = shimmerBaseRgb();
	const highlight = shimmerHighlightRgb(base);
	const band = Math.max(2, length * SHIMMER_BAND_RATIO);
	const phase = (Date.now() % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS;
	const center = -band + phase * (length + band * 2);
	let out = "";
	let lastAnsi = "";
	for (let i = 0; i < length; i++) {
		const distance = Math.abs(i + 0.5 - center) / band;
		// Cosine falloff: 1 at the band center, 0 once past the band edge. The exponent
		// tightens the skirt, so the band reads as a comet with a hot core rather than a
		// wash over the whole label.
		const falloff =
			distance >= 1 ? 0 : Math.pow(0.5 * (1 + Math.cos(Math.PI * distance)), SHIMMER_FALLOFF_POW);
		const rgb = mixRgb(base, highlight, falloff * SHIMMER_PEAK_MIX);
		const ansi = `\x1b[38;2;${Math.round(rgb.r)};${Math.round(rgb.g)};${Math.round(rgb.b)}m`;
		if (ansi !== lastAnsi) {
			out += ansi;
			lastAnsi = ansi;
		}
		out += text[i];
	}
	return `${out}${TRANSPARENT_RESET}`;
}

/** Track pi's thinking level: the shimmer band is painted in that level's theme color, so it
 *  has to follow /thinking, Shift+Tab, model switches, and session resume. */
function registerThinkingLevelTracking(pi: ExtensionAPI): void {
	pi.on("thinking_level_select", async (event) => {
		if (typeof event?.level === "string") _thinkingLevel = event.level;
	});
	const refresh = (_event: unknown, ctx: any) => {
		let level: unknown = ctx?.thinkingLevel;
		if (typeof level !== "string") {
			try {
				level = (pi as any)?.getThinkingLevel?.();
			} catch {
				level = undefined;
			}
		}
		if (typeof level === "string") _thinkingLevel = level;
	};
	pi.on("session_start", async (event, ctx) => refresh(event, ctx));
	pi.on("turn_start", async (event, ctx) => refresh(event, ctx));
}

// ---------------------------------------------------------------------------
// Footer status line
// ---------------------------------------------------------------------------

/** Key under which the footer status entry is published (`ctx.ui.setStatus`). */
const ACTIVITY_FOOTER_STATUS_KEY = "pi-activity";
/** Elapsed-time tick between activity changes: the label can sit unchanged for
 *  a while (waiting on the model), but its elapsed time keeps advancing. */
const ACTIVITY_FOOTER_TICK_MS = 500;

type ActivityFooterUi = { setStatus?: (key: string, text: string | undefined) => void };

/** Default footer element: publish the current activity (label + elapsed time)
 *  into pi's footer status cluster via `ctx.ui.setStatus`, updating live through
 *  the tracker's subscription plus a small tick so elapsed time advances between
 *  events. Goes quiet when no run is active (the status entry is removed), and
 *  degrades to a no-op when the footer API is unavailable (headless, RPC) or the
 *  `activityFooter` setting is off (default on). */
function registerActivityFooter(pi: ExtensionAPI): void {
	let ui: ActivityFooterUi | null = null;
	let enabled = false;
	let unsubscribe: (() => void) | null = null;
	let tick: ReturnType<typeof setInterval> | null = null;

	const stopTick = (): void => {
		if (tick === null) return;
		clearInterval(tick);
		tick = null;
	};
	const clear = (): void => {
		stopTick();
		try {
			ui?.setStatus?.(ACTIVITY_FOOTER_STATUS_KEY, undefined);
		} catch { /* best effort */ }
	};
	const publish = (): void => {
		if (!ui || !enabled) return;
		const activity = activitySnapshot();
		if (!activity.isWorking) {
			// Quiet when nothing is running: drop the status entry entirely.
			clear();
			return;
		}
		const label = activity.label ?? (activity.phase === "waiting" ? DEFAULT_ACTIVITY_LABEL : activity.phase);
		const elapsed = activity.labelStartedAt === null ? activity.run.elapsedMs : activity.labelElapsedMs;
		const text = `${label} · ${formatWorkedDuration(elapsed)}`;
		try {
			ui.setStatus?.(ACTIVITY_FOOTER_STATUS_KEY, text);
		} catch { /* best effort */ }
		if (tick === null) {
			tick = setInterval(publish, ACTIVITY_FOOTER_TICK_MS);
			try { (tick as any)?.unref?.(); } catch { /* not a Node timer */ }
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		clear();
		unsubscribe?.();
		unsubscribe = null;
		ui = null;
		enabled = activityFooterEnabled();
		const candidate = (ctx as any)?.ui as ActivityFooterUi | undefined;
		// Degrade gracefully: hosts without a UI (or without setStatus) just skip it.
		if (!enabled || !candidate || typeof candidate.setStatus !== "function") return;
		ui = candidate;
		unsubscribe = activitySubscribe(() => publish());
		publish();
	});
	pi.on("session_shutdown", async () => {
		clear();
		unsubscribe?.();
		unsubscribe = null;
		ui = null;
		enabled = false;
	});
}

// ---------------------------------------------------------------------------
// Duration formatting for the footer / worked time
// ---------------------------------------------------------------------------

function formatWorkedDuration(ms: number): string {
	const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
	if (safeMs < 60_000) {
		return `${Math.max(0, Math.floor(safeMs / 1000))}s`;
	}
	let days = Math.floor(safeMs / 86_400_000);
	let hours = Math.floor((safeMs % 86_400_000) / 3_600_000);
	let minutes = Math.floor((safeMs % 3_600_000) / 60_000);
	let seconds = Math.round((safeMs % 60_000) / 1000);
	if (seconds === 60) {
		seconds = 0;
		minutes++;
	}
	if (minutes === 60) {
		minutes = 0;
		hours++;
	}
	if (hours === 24) {
		hours = 0;
		days++;
	}
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	return `${minutes}m ${seconds}s`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/** pi extension entry point. */
export default function piActivity(pi: ExtensionAPI): void {
	// Advertise the opt-in activity integration and start tracking activity
	// before any tool registers or a run starts.
	registerActivityApi(pi);
	registerBuiltinActivityTools(pi);
	// Stamp worked/thinking durations into messages so session totals and
	// resume seeding survive restarts.
	registerWorkedTiming(pi);
	// The shimmer band is painted in the current thinking level's theme color.
	registerThinkingLevelTracking(pi);
	// Default footer element: the current activity, live.
	registerActivityFooter(pi);
}

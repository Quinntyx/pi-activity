# Activity API

Other extensions can ask this one what the session is doing — and what it has
done — without scraping the transcript or hooking the renderer.

```ts
const api = (globalThis as any)[Symbol.for("pi-activity:api")];
if (api?.getActivity) {
	const { phase, label, run } = api.getActivity();
	// "tool", "implementing", { toolCalls: 3, elapsedMs: 41_200, … }
}
```

The object is published on `globalThis` under **three keys, all pointing at the
same instance** (so state and subscriptions are shared):

| Key | Notes |
| --- | --- |
| `Symbol.for("pi-activity:api")` | Preferred. |
| `Symbol.for("pi-tool-tree:api")` | Legacy alias, kept so plugins written against pi-tool-tree keep working when it is absent. |
| `Symbol.for("pi-tool-tree:activity-api")` | The key the activity-label hook shipped with in pi-tool-tree; kept for plugins written against it. |

> **Load order caveat:** when pi-tool-tree is *also* loaded, both extensions
> publish to the legacy `pi-tool-tree:api` key, and whichever publishes last
> (extension load order) decides which object sits there. This is safe for
> legacy consumers: those readers only need the activity methods —
> `getActivity`, `getStats`, `subscribe`, `formatDuration`, `shimmerText`,
> `wrapTool`, `param`, `defaultLabel`, `enabled`, `version`,
> `shimmerIntervalMs` — which both objects provide. New code should prefer the
> canonical `pi-activity:api` key, which pi-tool-tree never publishes. pi-tool-tree
> itself is unchanged and is not a dependency of this plugin. For a tree-free
> setup, disable pi-tool-tree and load pi-activity before opt-in consumers.

- [Quick start](#quick-start)
- [`getActivity()`](#getactivity)
- [`getStats()`](#getstats)
- [`subscribe(listener)`](#subscribelistener)
- [`formatDuration(ms)`](#formatdurationms)
- [`shimmerText(text, theme?)`](#shimmertexttext-theme)
- [`wrapTool(tool)`](#wraptooltool)
- [What the numbers mean](#what-the-numbers-mean)
- [What drives the state](#what-drives-the-state)
- [Guarantees and caveats](#guarantees-and-caveats)
- [TypeScript shapes](#typescript-shapes)

## Quick start

A status line that shows the current activity, updated whenever it changes:

```ts
const api = (globalThis as any)[Symbol.for("pi-activity:api")];
if (api?.subscribe) {
	api.subscribe((activity: any, change: any) => {
		if (change.type === "tool-end") {
			console.log(`${change.toolName} ${change.isError ? "failed" : "finished"} in ${api.formatDuration(change.durationMs)}`);
			return;
		}
		if (activity.isWorking) {
			console.log(`${activity.label}: ${activity.phase} (${api.formatDuration(activity.run.elapsedMs)})`);
		} else {
			console.log(`idle · ${api.formatDuration(api.getStats().workedMs)} of work this session`);
		}
	});
}
```

Getters are cheap and always current, so a component that repaints on its own
schedule can simply call `getActivity()` in its render instead of subscribing:
durations are measured at the moment you ask.

## `getActivity()`

Returns a snapshot of what is happening **right now**.

| Field | Type | Meaning |
| --- | --- | --- |
| `phase` | `"idle" \| "waiting" \| "thinking" \| "responding" \| "tool"` | What the agent is doing. See [phases](#phases). |
| `isWorking` | `boolean` | An agent run is in flight (`phase !== "idle"`). |
| `isThinking` | `boolean` | Reasoning is streaming right now. |
| `isRunningTool` | `boolean` | At least one tool call is executing right now. |
| `label` | `string \| null` | Model-declared activity label for the current phase (e.g. `"implementing"`). `null` only while idle. |
| `labelStartedAt` | `number \| null` | Epoch ms when the current label took effect. |
| `labelElapsedMs` | `number` | Wall time spent on the current label, measured to this call. |
| `labelCalls` | `number` | Tool calls started under the current label. |
| `thinkingStartedAt` | `number \| null` | Start of the reasoning block that is streaming, if any. |
| `thinkingElapsedMs` | `number` | Length of that block so far; `0` when nothing is streaming. |
| `calls` | `ActivityRunningCall[]` | Calls executing right now, in start order. |
| `run` | `ActivityRunStats` | Counters for the current run (all zero while idle). |

Each entry of `calls` has `toolCallId`, `toolName`, `label`, `startedAt`,
`elapsedMs` (live), and optionally `argPreview` (a one-line, 64-char preview of
the call's first string argument).

`run` carries `startedAt`, `elapsedMs`, `turns`, `toolCalls`,
`toolCallsRunning`, `toolCallsFailed`, `toolMs`, and `thinkingMs`.

### Phases

| Phase | When |
| --- | --- |
| `idle` | No run in flight. `run` is zeroed and `label` is `null`. |
| `waiting` | A run is in flight but nothing is streaming: waiting for the model's first token, or between a tool result and the next response. |
| `thinking` | Reasoning is streaming. |
| `responding` | The model is streaming output — answer text or tool-call arguments. |
| `tool` | At least one tool call is executing. Takes precedence over `thinking`/`responding`. |

```ts
const a = api.getActivity();
if (a.isRunningTool) {
	for (const call of a.calls) console.log(`${call.toolName} running ${api.formatDuration(call.elapsedMs)}`);
} else if (a.isThinking) {
	console.log(`thinking for ${api.formatDuration(a.thinkingElapsedMs)}`);
}
```

## `getStats()`

Returns cumulative statistics for the session, including history restored on
resume/reload/fork.

| Field | Type | Meaning |
| --- | --- | --- |
| `workedMs` | `number` | Completed agent work: the sum of finished runs, idle time excluded. The same number the transcript's `Total time` reports. |
| `runs` | `number` | Finished runs. |
| `turns` | `number` | pi turns across those runs (one model response plus the calls it made). |
| `toolCalls` | `number` | Tool calls that finished. |
| `toolCallsFailed` | `number` | Of those, the ones that ended with an error. |
| `toolMs` | `number` | Summed call time. |
| `thinkingMs` | `number` | Summed reasoning time. |
| `thinkingBlocks` | `number` | Reasoning blocks that finished. |
| `byTool` | `Record<string, { calls, failed, durationMs }>` | Per tool name. |
| `byLabel` | `Record<string, { calls, durationMs }>` | Per activity label. |

## `subscribe(listener)`

```ts
const unsubscribe = api.subscribe((activity, change) => { /* … */ });
unsubscribe();
```

The listener receives the snapshot **after** the change plus a description of
what changed. Listeners run synchronously as pi's events arrive; anything a
listener throws is swallowed so a broken consumer cannot take the agent down.

| `change.type` | Extra fields | Fired |
| --- | --- | --- |
| `run-start` | — | A run begins (`before_agent_start` / `agent_start`). Fires once per run: a second start event while the agent is busy (steering, queued prompt) does not reset it. |
| `turn-start` | — | A turn begins. |
| `label-change` | `label` | The model named a new phase. |
| `thinking-start` | — | Reasoning began streaming. |
| `thinking-end` | `durationMs` | Reasoning stopped (a missing `thinking_end` is closed by the next stream output or by the end of the message). |
| `stream-start` | — | The model started streaming output. |
| `stream-end` | — | It stopped. |
| `tool-start` | `toolCallId`, `toolName`, `label`, `argPreview` | A call started executing. |
| `tool-end` | `toolCallId`, `toolName`, `isError`, `durationMs` | A call finished. |
| `run-end` | `durationMs`, `run` | A run finished. The snapshot is already idle, so the finished run's totals are in `change.run`. |

Because the snapshot handed to a `run-end` listener is idle, read
`change.run` for that run's numbers:

```ts
api.subscribe((activity, change) => {
	if (change.type !== "run-end") return;
	console.log(`run finished: ${api.formatDuration(change.run.elapsedMs)}, ${change.run.toolCalls} calls, ${change.run.turns} turns`);
});
```

## `formatDuration(ms)`

The transcript's own duration formatting, so extension output can match it:
`"<1s"`, `"12s"`, `"3m 05s"`, `"1h 02m"`.

## `shimmerText(text, theme?)`

Paints `text` with the live activity label's shimmer — the same highlight band,
cosine falloff, period and thinking-level color a running label is swept with.
Use it when a surface of yours wants the same animation instead of a cheaper
approximation of it:

```ts
const api = (globalThis as any)[Symbol.for("pi-activity:api")];
const word = api?.shimmerText ? api.shimmerText(action, theme) : theme.fg("muted", action);
```

- Time-phased: repaint on `api.shimmerIntervalMs` (80ms) and the band advances
  on its own; no timer of ours has to drive it.
- `theme` is optional but recommended for callers that render outside pi's
  transcript: it adopts the caller's palette, so the sweep tracks `/thinking`
  and `Shift+Tab` exactly like the tree's own labels. Without a theme, the
  painter uses the theme adopted at `session_start`.
- The band's color follows the current thinking level's theme color, kept
  readable against the panel and visibly distinct from the label's base color.

Also on the object: `shimmerIntervalMs` — the repaint cadence the sweep expects.

## `wrapTool(tool)`

Adds the `activity` parameter to a tool definition another extension registers,
defaults a missing label, and strips it again before `execute` runs.

```ts
const api = (globalThis as any)[Symbol.for("pi-activity:api")];
pi.registerTool(api?.wrapTool ? api.wrapTool(buildMyTool()) : buildMyTool());
```

`pi.getAllTools()` exposes no `execute`, so tools this package does not own
cannot be wrapped from the outside — a plugin has to wrap its own definition
before registering it. `wrapTool` is a no-op when the `toolActivityParam`
setting is off, so it can be called unconditionally.

The other fields on the object describe that integration: `param` (`"activity"`),
`defaultLabel` (`"working"`), and `enabled()`.

## What the numbers mean

- **A run** is one prompt-to-answer cycle: `before_agent_start`/`agent_start`
  until `agent_end`.
- **A turn** is pi's unit: one model response plus the tool calls it makes.
- **A call** counts when it *starts* (in the snapshot) and settles when it
  *ends* (in session totals). A call that is still in flight when the run ends
  never produced a result, so it is settled as a failure rather than dropped.
- **`toolMs`** sums call spans. Calls run in parallel, so the sum can exceed the
  wall clock — it is time spent by calls, not time elapsed.
- **Live vs settled**: durations in `getActivity()` include the block or call
  that is running right now, measured to the moment you ask. Session counters in
  `getStats()` only move when something finishes, so a call in flight shows up
  in the snapshot and not in the totals.
- **Labels** come from the `activity` argument the model sends with a call.
  A call that carries no label inherits the label in effect (so MCP and plugin
  calls continue the current phase), and a phase the model has not named yet
  reports `defaultLabel` (`"working"`). `labelElapsedMs` restarts whenever the
  model names a new phase.
- **Idle gaps are excluded** from `workedMs`: time spent reading or typing a
  prompt is not agent work.

## What drives the state

The tracker listens to pi's own events, not to a renderer, so it is correct in
hosts that never paint grouped rows (RPC, headless, tests) and does not depend
on a component being on screen.

| pi event | Effect |
| --- | --- |
| `before_agent_start`, `agent_start` | Start a run (`run-start`). |
| `turn_start` | Count a turn (`turn-start`). |
| `message_start` / `message_end` (assistant) | Close any reasoning/streaming phase left open by the previous message; stamp worked/thinking durations into the message. |
| `message_update` (`thinking_start`/`thinking_delta`/`thinking_end`) | Open/close the reasoning block. |
| `message_update` (`text_*`, `toolcall_*`) | Close an unterminated reasoning block and open/close the output stream. |
| `tool_execution_start` | Count a call, resolve the label, add it to `calls` (`tool-start`). |
| `tool_execution_end` | Settle the call, accumulate per-tool/per-label/session stats (`tool-end`). |
| `agent_end` | Close the run, accumulate run totals (`run-end`). |
| `thinking_level_select`, `session_start`, `turn_start` | Keep the shimmer band's color tracking the current thinking level. |
| `session_start` | Reset run state, rebuild session counters and worked-time totals from the active branch, adopt the active theme for shimmer colors, (re)arm the footer. |
| `session_shutdown` | Reset run state, drop subscriptions, clear the footer entry. |

## Guarantees and caveats

- **Snapshots are copies.** Mutating what you get back never affects tracked
  state, and each call returns a fresh object.
- **Feature-detect, don't version-check.** `version` stays `1` — it describes the
  `wrapTool` integration contract, which has not changed. The query methods are
  additive, so test for them:

  ```ts
  const api = (globalThis as any)[Symbol.for("pi-activity:api")];
  if (typeof api?.getActivity !== "function") return; // extension not installed / older build
  ```

- **Subscriptions do not survive a reload.** `session_shutdown` drops them, and
  pi reloading extensions replaces the object, so register subscriptions from
  your extension's own init.
- **History has counts, not clocks.** Call counts, failures, runs, turns,
  reasoning time, and per-tool/per-label call counts are rebuilt from the
  session branch on resume. Call *durations* recorded before this process
  started are not recoverable, so `byTool.*.durationMs`, `byLabel.*.durationMs`,
  and `toolMs` only cover calls made since the process started.
- **Timings use `Date.now()`**, and are wall clock, not CPU time.
- **The API is read-only.** There is no way to drive the agent through it.

## TypeScript shapes

Copy these into your extension if you want typed access (all of them are also
exported from `extensions/index.ts`):

```ts
export type ActivityPhase = "idle" | "waiting" | "thinking" | "responding" | "tool";

export interface ActivityRunningCall {
	toolCallId: string;
	toolName: string;
	label: string;
	argPreview?: string;
	startedAt: number;
	elapsedMs: number;
}

export interface ActivityRunStats {
	startedAt: number | null;
	elapsedMs: number;
	turns: number;
	toolCalls: number;
	toolCallsRunning: number;
	toolCallsFailed: number;
	toolMs: number;
	thinkingMs: number;
}

export interface ActivitySnapshot {
	phase: ActivityPhase;
	isWorking: boolean;
	isThinking: boolean;
	isRunningTool: boolean;
	label: string | null;
	labelStartedAt: number | null;
	labelElapsedMs: number;
	labelCalls: number;
	thinkingStartedAt: number | null;
	thinkingElapsedMs: number;
	calls: ActivityRunningCall[];
	run: ActivityRunStats;
}

export interface ActivityToolStat { calls: number; failed: number; durationMs: number }
export interface ActivityLabelStat { calls: number; durationMs: number }

export interface ActivitySessionStats {
	workedMs: number;
	runs: number;
	turns: number;
	toolCalls: number;
	toolCallsFailed: number;
	toolMs: number;
	thinkingMs: number;
	thinkingBlocks: number;
	byTool: Record<string, ActivityToolStat>;
	byLabel: Record<string, ActivityLabelStat>;
}

export type ActivityChangeType =
	| "run-start" | "turn-start" | "label-change"
	| "thinking-start" | "thinking-end"
	| "stream-start" | "stream-end"
	| "tool-start" | "tool-end" | "run-end";

export interface ActivityChange {
	type: ActivityChangeType;
	toolCallId?: string;
	toolName?: string;
	label?: string;
	argPreview?: string;
	isError?: boolean;
	durationMs?: number;
	run?: ActivityRunStats;
}

export type ActivityListener = (activity: ActivitySnapshot, change: ActivityChange) => void;

export interface ActivityApi {
	version: 1;
	param: string;
	defaultLabel: string;
	enabled(): boolean;
	wrapTool<T extends object>(tool: T): T;
	getActivity(): ActivitySnapshot;
	getStats(): ActivitySessionStats;
	subscribe(listener: ActivityListener): () => void;
	formatDuration(ms: number): string;
	shimmerText(text: string, theme?: unknown): string;
	readonly shimmerIntervalMs: number;
}
```

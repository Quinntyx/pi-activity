# pi-activity

Model-tagged activity labels and live activity tracking for
[pi](https://github.com/earendil-works/pi). Extracted from
[pi-tool-tree](https://git.quinntyx.dev/quinntyx/pi-tool-tree): the `activity` tool parameter, the
what-is-the-agent-doing API, the label shimmer painter, and a footer status
line — without any of the transcript rendering.

- **The `activity` parameter** — a required enum on model-facing tool calls:
  `exploring`, `planning`, `implementing`, `debugging`, `testing`, `reviewing`,
  `documenting`, or `working`. Reuse a phase until it changes. Callable schemas
  stay unchanged for codemode and programmatic callers; metadata is stripped
  before validation/execution and retained in recorded arguments for resume.
- **Activity tracking** — a headless listener on pi's own events that answers
  what the agent is doing right now (`getActivity`), what it has done this
  session (`getStats`), and when either changes (`subscribe`). Correct in RPC,
  headless, and test hosts; it never depends on anything being on screen.
- **The shimmer painter** — the exact highlight band the grouped transcript
  sweeps across a running label, published as `shimmerText(text, theme?)` so
  other surfaces don't re-implement a cheaper approximation of it.
- **The footer status line** — by default, the current label plus elapsed time
  in pi's footer status cluster, updating live, and going quiet when no run is
  active.

Full API reference: [API.md](API.md). Consumer updates and tree-removal audit:
[MIGRATION.md](MIGRATION.md).

## Install

Requires **Pi 0.99.1 or newer** (`context_with_system`). Load it before plugins that opt into its API:

```sh
pi install git:git.quinntyx.dev/quinntyx/pi-activity
```

Remove `pi-tool-tree` from your enabled packages if you no longer want its
rendering. This package neither changes nor depends on `pi-tool-tree`.

At session start, native `read`, `bash`, `edit`, `write`, `grep`, `find`, and
`ls` tools receive labels. Tools replaced by other extensions are left alone:
their authors opt in using `wrapTool`, preserving their custom renderers. The
active tool selection is preserved.

Only outgoing `toolsAdded` declarations gain the required enum; registered
schemas, codemode declarations, and programmatic calls remain unchanged. Raw
grammar tools (including native codemode) and tools with their own `activity`
argument are not modified. Nested calls inherit their parent's phase, or the
current phase when there is no labeled parent. The first unlabeled phase is
`working`. Omitted or invalid labels on wrapped direct calls are resolved before
persistence so renderers reading recorded arguments see the same label.

## Settings

Settings live beside pi's own `settings.json` (project `.pi/settings.json`,
`~/.pi/settings.json`, or `$PI_CODING_AGENT_DIR/settings.json`). See
[config/config.example.json](config/config.example.json).

| Setting | Default | Meaning |
| --- | --- | --- |
| `toolActivityParam` | `true` | Inject the required enum into wrapped tools' outgoing model declarations (`wrapTool`, `enabled()`). When off, labels fall back to the previous phase. |
| `activityFooter` | `true` | Show the current activity (label + elapsed) in the footer status cluster. |
| `themeAdaptive` | `true` | Derive shimmer colors from the active pi theme instead of the fixed fallbacks. |

Settings that only affect how pi-tool-tree *renders* the transcript
(`activityGroups`, `activityShimmer`, `groupToolCalls`, …) stay there — this
package neither reads nor writes them.

## Footer

By default the extension publishes one status entry under the key `pi-activity`
into pi's footer status cluster (`ctx.ui.setStatus`):

```
implementing · 41s
```

- It updates on every activity change (run/turn/label/thinking/tool) and on a
  500 ms tick so the elapsed time advances while nothing else happens.
- When no run is active, the entry is removed — the footer goes quiet.
- If pi's footer API is unavailable (headless mode, RPC), the footer is
  silently skipped.
- Set `"activityFooter": false` to disable it.

## Using the API from another extension

```ts
const api = (globalThis as any)[Symbol.for("pi-activity:api")];
if (api?.subscribe) {
	api.subscribe((activity, change) => {
		if (activity.isWorking) {
			console.log(`${activity.label}: ${activity.phase} (${api.formatDuration(activity.run.elapsedMs)})`);
		}
	});
}
```

See [API.md](API.md) for the full surface, including `wrapTool` for tagging
your own tools and `shimmerText` for the label sweep.

## Development

```sh
npm test
npm run typecheck
# Also exercise strict validation and a real codemode sandbox against installed Pi:
PI_ACTIVITY_TEST_SDK="$(npm root -g)/@earendil-works/pi-coding-agent/dist/index.js" npm test
```

The integration test is skipped when `PI_ACTIVITY_TEST_SDK` is unset. The older
SDK in the development dependency tree is supported for source typechecking,
not as a runtime for request-only activity injection.

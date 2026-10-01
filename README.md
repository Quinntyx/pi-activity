# pi-activity

Model-tagged activity labels and live activity tracking for
[pi](https://github.com/earendil-works/pi). Extracted from
[pi-tool-tree](https://git.quinntyx.dev/quinntyx/pi-tool-tree): the `activity` tool parameter, the
what-is-the-agent-doing API, the label shimmer painter, and a footer status
line — without any of the transcript rendering.

- **The `activity` parameter** — native tools and tools wrapped by this extension ask the model
  to tag every call with at most two lowercase words naming the current phase
  (`exploring`, `implementing`, `fixing-types`). Labels are stripped before
  execution and kept in the recorded arguments, so they survive resume.
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

Load it before plugins that opt into its API:

```sh
pi install git:git.quinntyx.dev/quinntyx/pi-activity
```

Remove `pi-tool-tree` from your enabled packages if you no longer want its
rendering. This package neither changes nor depends on `pi-tool-tree`.

At session start, native `read`, `bash`, `edit`, `write`, `grep`, `find`, and
`ls` tools receive labels. Tools replaced by other extensions are left alone:
their authors opt in using `wrapTool`, preserving their custom renderers. The
active tool selection is preserved.

## Settings

Settings live beside pi's own `settings.json` (project `.pi/settings.json`,
`~/.pi/settings.json`, or `$PI_CODING_AGENT_DIR/settings.json`). See
[config/config.example.json](config/config.example.json).

| Setting | Default | Meaning |
| --- | --- | --- |
| `toolActivityParam` | `true` | Inject the required `activity` param into wrapped tool schemas (`wrapTool`, `enabled()`). When off, labels fall back to the previous phase. |
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

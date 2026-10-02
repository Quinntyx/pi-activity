# Tree-free activity migration

`pi-tool-tree/main` was used only as a reference and is unchanged. There is no
new dependency from pi-tool-tree to pi-activity.

## Provider and consumers

`pi-activity` supplies the existing v1 activity API under the canonical
`Symbol.for("pi-activity:api")` key. The old `pi-tool-tree:api` and
`pi-tool-tree:activity-api` keys remain compatibility aliases. Updated consumers
use the canonical key so an unchanged pi-tool-tree cannot replace their provider.

Changes in the local source checkouts:

| Plugin | Checkout | Integration |
| --- | --- | --- |
| pi-pycells | `../pi-pycells/feat-notebook-output` | `src/utils.ts`: opt-in `wrapTool`; `main` is untouched |
| pi-sock | `../pi-sock/main` | `index.ts`: snapshot query and activity-change subscription |
| pi-ui-forge | `../pi-ui-forge/main` | `index.ts`: live editor activity subscription; unrelated working changes preserved |
| pi-subagents | `../pi-subagents/main` | Documentation strings updated; its existing pi-sock protocol needs no change |

Load pi-activity before plugins that wrap their tools during registration.
The main profile uses `git:git.quinntyx.dev/quinntyx/pi-activity` as its first
package, replacing pi-tool-tree. Existing installed consumers keep working via
the compatibility aliases; the canonical-key changes above are in their source
checkouts and become available when those consumer versions are published.
In particular, pi-pycells will pick up its canonical-key integration when
feat-notebook-output is merged.

## What must survive tree removal?

The installed main-profile plugin scan found no other tree API dependency that
requires another provider. The required pieces are all included here:

- Activity schema injection and argument stripping, with the same `wrapTool` API.
- Current activity, run/tool/thinking lifecycle and session statistics.
- Worked/thinking metadata and branch seeding, so resumed session totals do not
  depend on the old tree renderer stamping timestamps.
- Subscriptions, duration formatting and the public shimmer painter.
- `toolActivityParam` and theme settings used by these features.

The default presentation is one `ctx.ui.setStatus("pi-activity", ...)` footer
entry. No transcript components, tree rails, renderer monkey-patches or custom
footer replacement are installed. Native built-ins receive activity labels only
if they are still owned by pi; other extensions' tool definitions and renderers
are not replaced. Custom tools opt in through `wrapTool`.

## Optional features you lose with pi-tool-tree

These are independent presentation choices, not dependencies of the audited
consumer plugins:

- Edit/write diff previews, split/unified diff layout and syntax highlighting.
- Tool output summaries, preview shortcuts and bash/RTK display transformations.
- Math formatting, thinking display and the transcript worked-time line.
- `/cc-tools` and `/cc-theme` presentation commands. The underlying
  `toolActivityParam` setting remains available in pi-activity.

Extract those separately only if you want their presentation without the tree.
The bash duration formatter is already copied into this package; the rest of
`bash-command.ts` and `diff-mode.ts` is not needed for activity.

## Checks

- pi-activity typecheck and eight focused tests pass against its development SDK
  and the installed pi 0.99.1 SDK.
- pi-pycells/feat-notebook-output builds; pi-ui-forge's extension typechecks.
- pi-sock's standalone typecheck encounters a pre-existing undefined `pi` at
  `main/index.ts:431` (`pi.setSessionName(name.trim())`). The same statement is in
  HEAD; this migration does not change that handler.

## Required enum / request-only declarations (dev)

- Pi 0.99.1+ is required for `context_with_system`.
- `wrapTool` no longer adds an optional free-form field to registered schemas.
  It opts in to a required enum on outgoing model declarations only.
- Codemode/PTC callers keep the original schema and need not pass `activity`.
- Original `prepareArguments` hooks now receive arguments **without** activity
  metadata. It is stripped before strict schema validation, not just execution.
- Raw grammar tools and tools that own an `activity` argument are untouched.
- Invalid/omitted direct labels inherit the current phase before persistence;
  nested calls inherit their parent's phase. Old recorded labels are retained.

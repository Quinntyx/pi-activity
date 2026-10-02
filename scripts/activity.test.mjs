import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const scratch = mkdtempSync(join(tmpdir(), "pi-activity-test-"));
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = scratch;
process.chdir(scratch);
const jiti = createJiti(import.meta.url, {
  ...(process.env.PI_ACTIVITY_TEST_SDK ? {
    alias: { "@earendil-works/pi-coding-agent": process.env.PI_ACTIVITY_TEST_SDK },
  } : {}),
});
const mod = await jiti.import("../extensions/index.ts");
const native = await jiti.import("@earendil-works/pi-coding-agent");

function host({ tools = [], active = [], hasUI = true, branch = [] } = {}) {
  const handlers = new Map();
  const registered = new Map();
  const statuses = new Map();
  let selected = [...active];
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getAllTools: () => tools,
    getActiveTools: () => [...selected],
    setActiveTools: (names) => { selected = [...names]; },
    registerTool: (tool) => { registered.set(tool.name, tool); selected.push(tool.name); },
    getThinkingLevel: () => "high",
  };
  const ctx = {
    cwd: scratch,
    hasUI,
    sessionManager: { getBranch: () => branch },
    ...(hasUI ? { ui: { setStatus: (key, value) => statuses.set(key, value) } } : {}),
  };
  mod.default(pi);
  const api = globalThis[Symbol.for("pi-activity:api")];
  return {
    api, ctx, statuses, registered,
    active: () => selected,
    async emit(event, data = {}) {
      let result;
      for (const fn of handlers.get(event) ?? []) {
        const next = await fn(data, ctx);
        if (next?.messages) { data = { ...data, messages: next.messages }; result = next; }
      }
      return result;
    },
  };
}

const builtin = (name) => ({ name, sourceInfo: { source: "builtin" } });

test("published API keeps its complete v1 surface and legacy aliases", async () => {
  const h = host();
  await h.emit("session_start");
  assert.equal(h.api.version, 1);
  assert.equal(h.api.param, "activity");
  assert.equal(h.api.defaultLabel, "working");
  for (const method of ["enabled", "wrapTool", "getActivity", "getStats", "subscribe", "formatDuration", "shimmerText"]) {
    assert.equal(typeof h.api[method], "function", method);
  }
  assert.equal(h.api, globalThis[Symbol.for("pi-tool-tree:api")]);
  assert.equal(h.api, globalThis[Symbol.for("pi-tool-tree:activity-api")]);
  assert.equal(typeof h.api.shimmerIntervalMs, "number");
  assert.match(h.api.shimmerText("working"), /working|\u001b/);
  await h.emit("session_shutdown");
});

test("opt-in wrapping preserves renderer identity and strips labels before execution", async () => {
  const h = host();
  let received;
  let prepared;
  const renderCall = () => "custom call";
  const renderResult = () => "custom result";
  const original = {
    name: "custom", label: "custom", description: "custom tool",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    renderCall, renderResult,
    prepareArguments(args) { prepared = args; return { ...args, path: args.path.trim() }; },
    async execute(_id, args) { received = args; return { content: [] }; },
  };
  const wrapped = h.api.wrapTool(original);
  assert.equal(wrapped.renderCall, renderCall);
  assert.equal(wrapped.renderResult, renderResult);
  assert.equal(original.parameters.properties.activity, undefined);
  assert.equal(wrapped.parameters, original.parameters);
  assert.equal(wrapped.parameters.properties.activity, undefined);
  assert.deepEqual(wrapped.parameters.required, ["path"]);
  assert.equal(h.api.wrapTool(wrapped), wrapped);
  const input = { path: " a ", activity: "testing" };
  const args = wrapped.prepareArguments(input);
  assert.deepEqual(prepared, { path: " a " });
  await wrapped.execute("x", args, undefined, undefined, h.ctx);
  assert.deepEqual(received, { path: "a" });
  assert.equal(input.activity, "testing");
  assert.deepEqual(wrapped.prepareArguments({ path: "a" }), { path: "a" });
  await h.emit("session_shutdown");
});

test("native labels preserve active loadout and never replace another plugin's tool", async () => {
  const custom = { name: "bash", sourceInfo: { source: "extension", path: "/custom/bash.ts" } };
  const h = host({ tools: [builtin("read"), builtin("grep"), custom], active: ["read", "bash"] });
  await h.emit("session_start");
  assert.deepEqual([...h.registered.keys()], ["read", "grep"]);
  assert.deepEqual(h.active(), ["read", "bash"]);
  const factories = { read: native.createReadToolDefinition, grep: native.createGrepToolDefinition };
  for (const tool of h.registered.values()) {
    const original = factories[tool.name](scratch);
    assert.equal(tool.parameters.properties.activity, undefined);
    assert.deepEqual(tool.parameters, original.parameters);
    assert.equal(tool.renderCall?.toString(), original.renderCall?.toString());
    assert.equal(tool.renderResult?.toString(), original.renderResult?.toString());
  }
  await h.emit("session_shutdown");
});

test("wrapped native execution uses the current session cwd", async () => {
  const h = host({ tools: [builtin("read")], active: ["read"] });
  await h.emit("session_start");
  const other = join(scratch, "other");
  mkdirSync(other);
  writeFileSync(join(other, "hello.txt"), "current session directory");
  const read = h.registered.get("read");
  const result = await read.execute("read-1", { path: "hello.txt", activity: "testing" }, undefined, undefined, { ...h.ctx, cwd: other });
  assert.match(result.content[0].text, /current session directory/);
  await h.emit("session_shutdown");
});

test("run, thinking, tools, failures and subscriptions work without tree rendering", async () => {
  const h = host({ hasUI: false });
  await h.emit("session_start");
  const events = [];
  const unsubscribe = h.api.subscribe((snapshot, change) => events.push({ snapshot, change }));
  assert.equal(h.api.getActivity().phase, "idle");
  await h.emit("before_agent_start");
  await h.emit("agent_start");
  await h.emit("turn_start");
  await h.emit("message_start", { message: { role: "assistant", content: [] } });
  await h.emit("message_update", { message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_start" } });
  assert.equal(h.api.getActivity().phase, "thinking");
  await h.emit("message_update", { message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_end" } });
  await h.emit("tool_execution_start", { toolCallId: "a", toolName: "read", args: { path: "a", activity: "EXPLORING" } });
  assert.equal(h.api.getActivity().phase, "tool");
  assert.equal(h.api.getActivity().label, "exploring");
  assert.equal(h.api.getActivity().calls[0].toolName, "read");
  await h.emit("tool_execution_start", { toolCallId: "b", toolName: "bash", args: { activity: "testing" } });
  await h.emit("tool_execution_end", { toolCallId: "a", toolName: "read", isError: false });
  assert.equal(h.api.getActivity().calls.length, 1);
  await h.emit("tool_execution_end", { toolCallId: "b", toolName: "bash", isError: true });
  await h.emit("message_end", { message: { role: "assistant", content: [], stopReason: "stop" } });
  await h.emit("agent_end");
  const stats = h.api.getStats();
  assert.equal(stats.runs, 1);
  assert.equal(stats.turns, 1);
  assert.equal(stats.toolCalls, 2);
  assert.equal(stats.toolCallsFailed, 1);
  assert.equal(stats.byLabel.exploring.calls, 1);
  assert.equal(h.api.getActivity().isWorking, false);
  assert.ok(events.some(({ change }) => change.type === "tool-start"));
  unsubscribe();
  const count = events.length;
  await h.emit("agent_start");
  assert.equal(events.length, count);
  await h.emit("session_shutdown");
});

test("footer shows the activity, advances elapsed time and clears on idle/shutdown", async () => {
  const h = host();
  await h.emit("session_start");
  assert.equal(h.statuses.get("pi-activity"), undefined);
  await h.emit("agent_start");
  await h.emit("tool_execution_start", { toolCallId: "a", toolName: "read", args: { activity: "testing" } });
  assert.match(h.statuses.get("pi-activity"), /^testing · /);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.match(h.statuses.get("pi-activity"), /^testing · 1s$/);
  await h.emit("tool_execution_end", { toolCallId: "a", toolName: "read", isError: false });
  await h.emit("agent_end");
  assert.equal(h.statuses.get("pi-activity"), undefined);
  await h.emit("session_shutdown");
});

test("resume seeds tool stats and session transitions clear old run state", async () => {
  const h = host({ hasUI: false, branch: [
    { type: "message", message: { role: "user", content: "request" } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "old", name: "read", arguments: { activity: "reading" } }], stopReason: "toolUse" } },
    { type: "message", message: { role: "toolResult", toolCallId: "old", toolName: "read", isError: false, content: [] } },
  ] });
  await h.emit("session_start");
  assert.equal(h.api.getStats().toolCalls, 1);
  assert.equal(h.api.getStats().byLabel.reading.calls, 1);
  await h.emit("agent_start");
  await h.emit("session_start");
  assert.equal(h.api.getActivity().phase, "idle");
  assert.equal(h.api.getStats().toolCalls, 1);
  await h.emit("session_shutdown");
});


test("only outgoing declarations gain a required enum, including later tool additions", async () => {
  const h = host();
  const original = { name: "direct_enum", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, execute: async () => ({ content: [] }) };
  const wrapped = h.api.wrapTool(original);
  const unwrapped = { ...original, name: "unwrapped" };
  const raw = h.api.wrapTool({ ...original, name: "raw_grammar", constrainedSampling: { type: "grammar", variants: { openai_lark: "raw source" } } });
  assert.equal(raw.parameters, original.parameters);
  const messages = [
    { role: "system", content: "prompt", toolsAdded: [wrapped, unwrapped, raw], timestamp: 1 },
    { role: "user", content: "request", timestamp: 2 },
    { role: "system", content: "later", toolsRemoved: [{ name: "other" }], toolsAdded: [wrapped], timestamp: 3 },
  ];
  const before = JSON.stringify(messages);
  const result = await h.emit("context_with_system", { messages });
  assert.equal(JSON.stringify(messages), before);
  assert.equal(wrapped.parameters, original.parameters);
  assert.equal(result.messages[1], messages[1]);
  for (const index of [0, 2]) {
    const schema = result.messages[index].toolsAdded[0].parameters;
    assert.deepEqual(schema.required, ["path", "activity"]);
    assert.deepEqual(schema.properties.activity.enum, [...mod.ACTIVITY_LABELS]);
    assert.equal(schema.additionalProperties, false);
    assert.ok(!schema.properties.activity.default);
  }
  assert.equal(result.messages[0].toolsAdded[1], unwrapped);
  assert.equal(result.messages[0].toolsAdded[2], raw);
  assert.deepEqual(result.messages[2].toolsRemoved, messages[2].toolsRemoved);
  const again = await h.emit("context_with_system", result);
  assert.deepEqual(again, result);
  await h.emit("session_shutdown");
});

test("schema edge cases and tool-owned activity arguments are not hijacked", async () => {
  assert.equal(mod.withActivityParam({ type: "string" }), undefined);
  assert.equal(mod.withActivityParam({ type: "object", properties: [] }), undefined);
  const existing = { type: "object", properties: { activity: { type: "number" } }, required: ["activity"] };
  assert.equal(mod.withActivityParam(existing), undefined);
  assert.deepEqual(mod.withActivityParam({ type: "object", properties: {} }).required, ["activity"]);
  const h = host();
  const tool = { name: "own_activity", parameters: existing, execute: async () => ({ content: [] }) };
  assert.equal(h.api.wrapTool(tool), tool);
  const result = await h.emit("context_with_system", { messages: [{ role: "system", toolsAdded: [tool] }] });
  assert.equal(result.messages[0].toolsAdded[0], tool);
  await h.emit("session_shutdown");
});

test("omitted and invalid labels inherit before persistence; unwrapped calls remain untouched", async () => {
  const h = host({ hasUI: false });
  h.api.wrapTool({ name: "fallback_enum", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });
  await h.emit("session_start");
  const first = { role: "assistant", content: [{ type: "toolCall", id: "initial", name: "fallback_enum", arguments: {} }] };
  await h.emit("message_end", { message: first });
  assert.equal(first.content[0].arguments.activity, "working");
  const rawArgs = { activity: " TESTING " };
  const message = { role: "assistant", content: [
    { type: "toolCall", id: "valid", name: "fallback_enum", arguments: rawArgs },
    { type: "toolCall", id: "missing", name: "fallback_enum", arguments: {} },
    { type: "toolCall", id: "sentence", name: "fallback_enum", arguments: { activity: "checking the streaming usage" } },
    { type: "toolCall", id: "suffix", name: "fallback_enum", arguments: { activity: "exploring-foo" } },
    { type: "toolCall", id: "untouched", name: "codemode", arguments: { code: "await tools.read({path: 'x'})" } },
  ] };
  await h.emit("message_end", { message });
  assert.equal(rawArgs.activity, " TESTING ");
  assert.deepEqual(message.content.slice(0, 4).map((c) => c.arguments.activity), ["testing", "testing", "testing", "testing"]);
  assert.equal(message.content[4].arguments.activity, undefined);
  await h.emit("tool_execution_start", { toolCallId: "valid", toolName: "fallback_enum", args: message.content[0].arguments });
  await h.emit("tool_execution_start", { toolCallId: "bad", toolName: "read", args: { activity: "a very long sentence" } });
  assert.equal(h.api.getActivity().label, "testing");
  const later = { role: "assistant", content: [{ type: "toolCall", id: "later", name: "fallback_enum", arguments: { activity: 123 } }] };
  await h.emit("message_end", { message: later });
  assert.equal(later.content[0].arguments.activity, "testing");
  await h.emit("session_shutdown");
});


test("nested calls inherit their parent phase even when another call changes the current phase", async () => {
  const h = host({ hasUI: false });
  h.api.wrapTool({ name: "nested_enum", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });
  await h.emit("session_start");
  await h.emit("tool_execution_start", { toolCallId: "parent", toolName: "bash", args: { activity: "testing" } });
  await h.emit("tool_execution_start", { toolCallId: "sibling", toolName: "read", args: { activity: "reviewing" } });
  const args = {};
  await h.emit("tool_execution_start", { toolCallId: "child", parentToolCallId: "parent", toolName: "nested_enum", args });
  assert.equal(h.api.getActivity().calls.find((call) => call.toolCallId === "child").label, "testing");
  assert.equal(args.activity, "testing");
  await h.emit("session_shutdown");
});

test("installed Pi validates direct metadata and real codemode calls against the original strict schema", { skip: !process.env.PI_ACTIVITY_TEST_SDK }, async () => {
  const sdk = pathToFileURL(process.env.PI_ACTIVITY_TEST_SDK);
  const { runToolCall } = await import(new URL("../node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js", sdk));
  const { executeCodemode } = await import(new URL("./extensions/codemode/execute.js", sdk));
  const { wrapToolDefinition } = await import(new URL("./core/tools/tool-definition-wrapper.js", sdk));
  const h = host({ hasUI: false });
  const received = [];
  const definition = h.api.wrapTool({
    name: "strict_echo", label: "Echo", description: "Echo a path", exposure: "direct",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    execute: async (_id, args) => { received.push(args); return { content: [{ type: "text", text: args.path }] }; },
  });
  const tool = wrapToolDefinition(definition);
  const context = { messages: [], tools: [tool] };
  const assistantMessage = { role: "assistant", content: [], timestamp: 1 };
  const direct = { type: "toolCall", id: "direct", name: tool.name, arguments: { path: "direct", activity: "testing" } };
  const outcome = await runToolCall(direct, { context, assistantMessage });
  assert.equal(outcome.isError, false, JSON.stringify(outcome.result));
  assert.equal(direct.arguments.activity, "testing");
  const result = await executeCodemode("script", { code: 'return await tools.strict_echo({path: "nested"});' }, new AbortController().signal, undefined, {
    tools: [tool], sessionManager: { getBranch: () => [] },
    executeTool: (name, args) => runToolCall({ type: "toolCall", id: "script/echo", name, arguments: args }, { context, assistantMessage }),
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.details.calls[0].status, "ok");
  assert.deepEqual(received, [{ path: "direct" }, { path: "nested" }]);
  assert.equal(tool.parameters.properties.activity, undefined);
  assert.ok(result.content.some((c) => c.text?.includes("nested")));
  await h.emit("session_shutdown");
});

test("activity settings disable wrapping and footer without affecting tracking", async () => {
  writeFileSync(join(scratch, "settings.json"), JSON.stringify({ toolActivityParam: false, activityFooter: false }));
  const now = Date.now;
  Date.now = () => now() + 6000; // expire the extracted five-second settings cache
  try {
    const h = host({ tools: [builtin("read")], active: ["read"] });
    await h.emit("session_start");
    assert.equal(h.api.enabled(), false);
    assert.equal(h.registered.size, 0);
    const tool = { parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) };
    assert.equal(h.api.wrapTool(tool), tool);
    await h.emit("agent_start");
    assert.equal(h.api.getActivity().isWorking, true);
    assert.equal(h.statuses.get("pi-activity"), undefined);
    await h.emit("session_shutdown");
  } finally {
    Date.now = now;
  }
});

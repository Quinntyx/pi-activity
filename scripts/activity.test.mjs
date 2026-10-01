import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      for (const fn of handlers.get(event) ?? []) await fn(data, ctx);
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
  assert.ok(wrapped.parameters.properties.activity);
  assert.deepEqual(wrapped.parameters.required, ["path"]);
  assert.equal(h.api.wrapTool(wrapped), wrapped);
  const input = { path: " a ", activity: "testing" };
  const args = wrapped.prepareArguments(input);
  assert.equal(prepared, input);
  await wrapped.execute("x", args, undefined, undefined, h.ctx);
  assert.deepEqual(received, { path: "a" });
  assert.equal(input.activity, "testing");
  assert.equal(wrapped.prepareArguments({ path: "a" }).activity, "working");
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
    assert.ok(tool.parameters.properties.activity);
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
  const result = await read.execute("read-1", { path: "hello.txt", activity: "checking" }, undefined, undefined, { ...h.ctx, cwd: other });
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
  await h.emit("tool_execution_start", { toolCallId: "a", toolName: "read", args: { activity: "checking" } });
  assert.match(h.statuses.get("pi-activity"), /^checking · /);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.match(h.statuses.get("pi-activity"), /^checking · 1s$/);
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

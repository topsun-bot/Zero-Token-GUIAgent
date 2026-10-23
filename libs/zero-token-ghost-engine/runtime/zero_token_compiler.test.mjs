import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AXTreeSessionDiffEngine, ZeroTokenSkillRuntime } from "./zero_token_compiler.mjs";

const scope = { bundleId: "test.app", windowId: 1 };
const tree = "- [1] Button Continue";
const success = { ok: true, executed: true, verified: true };

function fixture(rpcTransport, options = {}) {
  const snapshotManager = new AXTreeSessionDiffEngine();
  const observation = snapshotManager.observe({ ...scope, rawTreeText: tree });
  const request = { ...scope, snapshotId: observation.snapshot_id, action: "click", element_index: 1 };
  const runtime = new ZeroTokenSkillRuntime({ snapshotManager, rpcTransport, ...options });
  const code = `nodeRepl.write(await nodeRepl.rpc("test-service", ${JSON.stringify(request)}));`;
  return { snapshotManager, request, runtime, code };
}

test("UTF-8 byte limit rejects multibyte input and leaves previous snapshot valid", () => {
  const engine = new AXTreeSessionDiffEngine({ maxBytes: 24 });
  const first = engine.observe({ ...scope, rawTreeText: tree });
  assert.throws(() => engine.observe({ ...scope, rawTreeText: "- [1] " + "界".repeat(8) }), { code: "AX_TREE_TOO_LARGE" });
  assert.equal(engine.verifySnapshotLock({ ...scope, snapshotId: first.snapshot_id }), true);
});

test("node limit rejects excess parsed nodes instead of returning unbounded full text", () => {
  const engine = new AXTreeSessionDiffEngine({ maxNodes: 1 });
  assert.throws(() => engine.observe({ ...scope, rawTreeText: "- [1] A\n- [2] B" }), { code: "AX_NODE_LIMIT_EXCEEDED" });
});

test("limits require positive integers and input requires text", () => {
  assert.throws(() => new AXTreeSessionDiffEngine({ maxBytes: 0 }), { code: "INVALID_LIMIT" });
  assert.throws(() => new AXTreeSessionDiffEngine({ maxNodes: 1.5 }), { code: "INVALID_LIMIT" });
  assert.throws(() => new AXTreeSessionDiffEngine().observe({ ...scope, rawTreeText: null }), { code: "INVALID_AX_TREE" });
});

test("accepted full observations retain their text and diff revisions invalidate old locks", () => {
  const engine = new AXTreeSessionDiffEngine();
  const first = engine.observe({ ...scope, rawTreeText: tree });
  assert.equal(first.diff_text, tree);
  const next = engine.observe({ ...scope, rawTreeText: "- [1] Button Done" });
  assert.equal(next.base_revision, first.revision);
  assert.equal(next.changed_count, 1);
  assert.throws(() => engine.verifySnapshotLock({ ...scope, snapshotId: first.snapshot_id }), { code: "STALE_SNAPSHOT_LOCK" });
});

test("window zero is distinct from the primary scope", () => {
  const engine = new AXTreeSessionDiffEngine();
  const observed = engine.observe({ bundleId: scope.bundleId, windowId: 0, rawTreeText: tree });
  assert.throws(() => engine.verifySnapshotLock({ bundleId: scope.bundleId, snapshotId: observed.snapshot_id }), { code: "STALE_SNAPSHOT_LOCK" });
});

test("real dispatch without a transport is refused instead of simulated", async () => {
  const { runtime, code } = fixture();
  await assert.rejects(runtime.executeCell(code), { code: "RPC_TRANSPORT_REQUIRED" });
});

test("missing action scope is refused before transport", async () => {
  let calls = 0;
  const { runtime } = fixture(async () => { calls++; return success; });
  await assert.rejects(runtime.executeCell('await nodeRepl.rpc("test-service", { action: "click" });'), { code: "INVALID_ACTION_SCOPE" });
  assert.equal(calls, 0);
});

test("missing snapshot token is refused before transport", async () => {
  let calls = 0;
  const { runtime, request } = fixture(async () => { calls++; return success; });
  delete request.snapshotId;
  await assert.rejects(runtime.executeCell(`await nodeRepl.rpc("test-service", ${JSON.stringify(request)});`), { code: "STALE_SNAPSHOT_LOCK" });
  assert.equal(calls, 0);
});

test("a fresh observation makes an earlier action token stale", async () => {
  let calls = 0;
  const { runtime, code, snapshotManager } = fixture(async () => { calls++; return success; });
  snapshotManager.observe({ ...scope, rawTreeText: "- [1] Button Delete" });
  await assert.rejects(runtime.executeCell(code), { code: "STALE_SNAPSHOT_LOCK" });
  assert.equal(calls, 0);
});

test("an action cannot reuse a token in another window", async () => {
  let calls = 0;
  const { runtime, request } = fixture(async () => { calls++; return success; });
  request.windowId = 2;
  await assert.rejects(runtime.executeCell(`await nodeRepl.rpc("test-service", ${JSON.stringify(request)});`), { code: "STALE_SNAPSHOT_LOCK" });
  assert.equal(calls, 0);
});

test("each dispatch rechecks the observation even within one cell", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    f.snapshotManager.observe({ ...scope, rawTreeText: "- [1] Button Changed" });
    return success;
  });
  await assert.rejects(f.runtime.executeCell(f.code + f.code), { code: "STALE_SNAPSHOT_LOCK" });
  assert.equal(calls, 1);
});

test("an asynchronous adapter receives the validated request even if the caller mutates its original", async () => {
  let received;
  const { runtime, request } = fixture(async (_service, payload) => {
    await delay(5);
    received = payload;
    return success;
  });
  request.target = { element_index: 1, coordinates: [10, 20] };
  await runtime.executeCell(`
    const request = ${JSON.stringify(request)};
    const pending = nodeRepl.rpc("test-service", request);
    request.windowId = 2;
    request.element_index = 99;
    request.target.element_index = 99;
    request.target.coordinates[0] = 999;
    await pending;
  `);
  assert.equal(received.windowId, 1);
  assert.equal(received.element_index, 1);
  assert.equal(received.target.element_index, 1);
  assert.deepEqual(received.target.coordinates, [10, 20]);
  assert.equal(Object.isFrozen(received), true);
  assert.equal(Object.isFrozen(received.target), true);
  assert.equal(Object.isFrozen(received.target.coordinates), true);
});

test("the adapter cannot mutate the validated request payload", async () => {
  const { runtime, code } = fixture(async (_service, payload) => {
    assert.throws(() => { payload.windowId = 2; }, TypeError);
    return success;
  });
  assert.equal((await runtime.executeCell(code)).verified, true);
});

test("non-JSON and circular request data are refused before dispatch", async () => {
  let calls = 0;
  const { runtime, request } = fixture(async () => { calls++; return success; });
  for (const extra of ["request.self = request;", "request.callback = () => {};", "request.amount = NaN;", "Object.defineProperty(request, 'windowId', { get() { return 1; }, enumerable: true });"]) {
    await assert.rejects(runtime.executeCell(`const request = ${JSON.stringify(request)}; ${extra} await nodeRepl.rpc("test-service", request);`), { code: "INVALID_RPC_PAYLOAD" });
  }
  assert.equal(calls, 0);
});

test("transport exceptions propagate without being converted to success", async () => {
  const failure = new Error("adapter unavailable");
  const { runtime, code } = fixture(async () => { throw failure; });
  await assert.rejects(runtime.executeCell(code), (error) => error === failure);
});

test("an explicit failed transport receipt rejects the cell", async () => {
  const { runtime, code } = fixture(async () => ({ ok: false, executed: false, error: "permission denied" }));
  await assert.rejects(runtime.executeCell(code), { code: "RPC_TRANSPORT_FAILED" });
});

test("a missing receipt is not accepted as action success", async () => {
  const { runtime, code } = fixture(async () => undefined);
  await assert.rejects(runtime.executeCell(code), { code: "INVALID_TRANSPORT_RESPONSE" });
});

test("a simulated receipt cannot count as an executed action", async () => {
  const { runtime, code } = fixture(async () => ({ ...success, simulated: true }));
  await assert.rejects(runtime.executeCell(code), { code: "SIMULATED_TRANSPORT_RESPONSE" });
});

test("execution and verification remain separate", async () => {
  const { runtime, code } = fixture(async () => ({ ok: true, executed: true }));
  const result = await runtime.executeCell(code);
  assert.equal(result.executed, true);
  assert.equal(result.verified, false);
  assert.equal(result.outputs[0].verified, false);
});

test("mutating a script-visible receipt cannot upgrade the internal audit result", async () => {
  const { runtime, request } = fixture(async () => ({ ok: true, executed: true, verified: false }));
  const result = await runtime.executeCell(`
    const receipt = await nodeRepl.rpc("test-service", ${JSON.stringify(request)});
    receipt.verified = true;
    nodeRepl.write(receipt);
  `);
  assert.equal(result.outputs[0].verified, true);
  assert.equal(result.verified, false);
  assert.equal(result.actions[0].verified, false);
  assert.notEqual(result.actions[0], result.outputs[0]);
});

test("an ok receipt alone does not establish execution or verification", async () => {
  const { runtime, code } = fixture(async () => ({ ok: true, verified: true }));
  const result = await runtime.executeCell(code);
  assert.equal(result.executed, false);
  assert.equal(result.verified, false);
  assert.equal(result.outputs[0].executed, null);
  assert.equal(result.outputs[0].verified, false);
});

test("an explicitly executed and verified receipt is reported with unknown adapter usage", async () => {
  const { runtime, code } = fixture(async () => success);
  const result = await runtime.executeCell(code);
  assert.equal(result.executed, true);
  assert.equal(result.verified, true);
  assert.equal(result.token_usage.runtime_model_calls, 0);
  assert.equal(result.token_usage.external_adapter_tokens, null);
  assert.equal(result.token_usage.total_tokens, null);
  assert.equal(result.llm_tokens_consumed, null);
});

test("snapshot_id spelling is accepted without removing the lock", async () => {
  const { runtime, request } = fixture(async () => success);
  request.snapshot_id = request.snapshotId;
  delete request.snapshotId;
  const result = await runtime.executeCell(`await nodeRepl.rpc("test-service", ${JSON.stringify(request)});`);
  assert.equal(result.verified, true);
});

test("timeout prevents later dispatch but cannot undo an already sent action", async () => {
  const calls = [];
  const { runtime, code } = fixture(async (_service, request, { signal }) => {
    calls.push({ request, signal });
    await delay(70);
    return success;
  });
  await assert.rejects(runtime.executeCell(`try { ${code} } catch {} ${code}`, { timeoutMs: 20 }), { code: "CELL_TIMEOUT" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true);
  await delay(90);
  assert.equal(calls.length, 1);
});

test("timeout during a delay refuses the first subsequent dispatch", async () => {
  let calls = 0;
  const { runtime, code } = fixture(async () => { calls++; return success; });
  await assert.rejects(runtime.executeCell(`await new Promise(resolve => setTimeout(resolve, 60)); ${code}`, { timeoutMs: 15 }), { code: "CELL_TIMEOUT" });
  await delay(80);
  assert.equal(calls, 0);
});

test("an expired cell cannot borrow a later cell's dispatch authority", async () => {
  let calls = 0;
  const { runtime, code } = fixture(async () => { calls++; return success; });
  await assert.rejects(runtime.executeCell(`await new Promise(resolve => setTimeout(resolve, 50)); ${code}`, { timeoutMs: 10 }), { code: "CELL_TIMEOUT" });
  await runtime.executeCell("await new Promise(resolve => setTimeout(resolve, 70));");
  assert.equal(calls, 0);
});

test("synchronous loops time out and the runtime can accept a later cell", async () => {
  const runtime = new ZeroTokenSkillRuntime();
  await assert.rejects(runtime.executeCell("while (true) {}", { timeoutMs: 20 }), { code: "CELL_TIMEOUT" });
  const next = await runtime.executeCell("nodeRepl.write('recovered');");
  assert.equal(next.outputs[0], "recovered");
});

test("concurrent cells are refused while one cell is active", async () => {
  const runtime = new ZeroTokenSkillRuntime();
  const first = runtime.executeCell("await new Promise(resolve => setTimeout(resolve, 30));");
  await assert.rejects(runtime.executeCell("nodeRepl.write(2);"), { code: "RUNTIME_BUSY" });
  await first;
});

test("unawaited RPC failures cannot produce a successful cell receipt", async () => {
  const { runtime, request } = fixture(async () => {
    await delay(10);
    return { ok: false, executed: false };
  });
  await assert.rejects(runtime.executeCell(`nodeRepl.rpc("test-service", ${JSON.stringify(request)});`), { code: "RPC_TRANSPORT_FAILED" });
});

test("writing and replaying a skill does not certify it or promise zero total tokens", async () => {
  const skillCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "ghost-runtime-test-"));
  try {
    const runtime = new ZeroTokenSkillRuntime({ skillCacheDir });
    const artifact = await runtime.solidifySkill("demo", "nodeRepl.write(SKILL_PARAMS.value);");
    assert.equal(artifact.replayTokenCost, null);
    assert.equal(artifact.verified, false);
    assert.doesNotMatch(await fs.readFile(artifact.filePath, "utf8"), /Token Cost on Replay: 0/);
    const replay = await runtime.replaySolidifiedSkill("demo", { value: 42 });
    assert.equal(replay.outputs[0], 42);
    assert.equal(replay.executed, false);
    assert.equal(replay.verified, false);
    assert.equal(replay.token_usage.total_tokens, null);
  } finally {
    await fs.rm(skillCacheDir, { recursive: true, force: true });
  }
});

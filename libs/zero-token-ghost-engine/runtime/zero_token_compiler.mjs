/**
 * zero_token_compiler.mjs
 * CUA-Ghost: bounded AX text diffs and trusted-script replay.
 *
 * This module makes no model calls. External adapters may consume tokens; their
 * usage and total end-to-end cost are unknown here. Text token estimates are
 * character-count heuristics, not tokenizer measurements or benchmark results.
 *
 * Snapshots cover only observations supplied by the caller. Call observe again
 * after acquiring fresh UI state; this module neither watches the UI nor checks
 * screenshot IDs. A valid local token does not prove that the live UI is unchanged.
 *
 * Node's vm is NOT a security sandbox. Only execute trusted, reviewed scripts.
 * Timeouts prevent subsequent RPC dispatch but cannot undo a sent external action
 * or forcibly interrupt CPU work after an asynchronous continuation.
 */

import crypto from "node:crypto";
import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

function runtimeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw runtimeError("INVALID_LIMIT", `${name} must be a positive safe integer`);
  }
}

function scopeKeyFor({ bundleId, windowId } = {}) {
  if (typeof bundleId !== "string" || !bundleId.trim() ||
      (windowId != null && typeof windowId !== "string" && !Number.isSafeInteger(windowId))) {
    throw runtimeError("INVALID_ACTION_SCOPE", "A bundleId and optional string/integer windowId are required");
  }
  return JSON.stringify([bundleId, windowId ?? "primary"]);
}

function tokenUsage() {
  return { runtime_model_calls: 0, external_adapter_tokens: null, total_tokens: null };
}

// Copy data properties without invoking getters/toJSON. Only JSON values are
// accepted: null, booleans, strings, finite numbers, dense arrays and plain objects.
function copyFrozenJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return value;
  const invalid = () => runtimeError("INVALID_RPC_PAYLOAD", "RPC payloads must contain only acyclic JSON data properties");
  if (typeof value !== "object" || ancestors.has(value)) throw invalid();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== null && Object.getPrototypeOf(prototype) !== null) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const copyProperty = (key) => {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    return copyFrozenJson(descriptor.value, ancestors);
  };
  ancestors.add(value);
  let copy;
  if (array) {
    const length = descriptors.length.value;
    if (keys.length !== length + 1) throw invalid();
    copy = Array.from({ length }, (_, index) => copyProperty(String(index)));
  } else {
    copy = Object.fromEntries(keys.map((key) => [key, copyProperty(key)]));
  }
  ancestors.delete(value);
  return Object.freeze(copy);
}

export class AXTreeSessionDiffEngine {
  constructor({ maxNodes = 4000, maxBytes = 2 * 1024 * 1024 } = {}) {
    requirePositiveInteger(maxNodes, "maxNodes");
    requirePositiveInteger(maxBytes, "maxBytes");
    this.maxNodes = maxNodes;
    this.maxBytes = maxBytes;
    this.sessions = new Map();
  }

  /**
   * Diffs flat indexed AX text. Rejects excess UTF-8 bytes or parsed nodes before
   * replacing a snapshot. No tree-depth claim is made for this text-only parser.
   */
  observe({ bundleId, windowId, rawTreeText, disableDiff = false }) {
    const scopeKey = scopeKeyFor({ bundleId, windowId });
    if (typeof rawTreeText !== "string") {
      throw runtimeError("INVALID_AX_TREE", "rawTreeText must be a string");
    }
    if (Buffer.byteLength(rawTreeText, "utf8") > this.maxBytes) {
      throw runtimeError("AX_TREE_TOO_LARGE", `AX text exceeds ${this.maxBytes} UTF-8 bytes`);
    }
    const snapshotId = crypto.randomUUID().toUpperCase();
    const lines = rawTreeText.split("\n");
    const prev = this.sessions.get(scopeKey);

    const currentMap = new Map();
    let nodeCount = 0;
    for (const line of lines) {
      const m = line.match(/^\s*-\s*\[(\d+)\]\s*(.+)$/);
      if (m) {
        if (++nodeCount > this.maxNodes) {
          throw runtimeError("AX_NODE_LIMIT_EXCEEDED", `AX text exceeds ${this.maxNodes} indexed nodes`);
        }
        currentMap.set(m[1], m[2]);
      }
    }

    if (!prev || disableDiff) {
      const revision = prev ? prev.revision + 1 : 1;
      this.sessions.set(scopeKey, { revision, snapshotId, linesMap: currentMap, rawLines: lines });
      return {
        snapshot_id: snapshotId,
        revision,
        base_revision: null,
        mode: "full",
        token_estimate: Math.ceil(rawTreeText.length / 4),
        diff_text: rawTreeText,
      };
    }

    const added = [];
    const modified = [];
    const removed = [];

    for (const [idx, desc] of currentMap.entries()) {
      if (!prev.linesMap.has(idx)) {
        added.push(`+ [${idx}] ${desc}`);
      } else if (prev.linesMap.get(idx) !== desc) {
        modified.push(`~ [${idx}] ${desc}`);
      }
    }
    for (const [idx, desc] of prev.linesMap.entries()) {
      if (!currentMap.has(idx)) {
        removed.push(`- [${idx}] ${desc}`);
      }
    }

    const revision = prev.revision + 1;
    this.sessions.set(scopeKey, { revision, snapshotId, linesMap: currentMap, rawLines: lines });

    const diffLines = [
      `# AXTree Session Diff (revision=${revision}, base=${prev.revision}, snapshot_id=${snapshotId})`,
      ...added,
      ...modified,
      ...removed,
    ];
    const diffText = diffLines.join("\n");

    return {
      snapshot_id: snapshotId,
      revision,
      base_revision: prev.revision,
      mode: "diff",
      changed_count: added.length + modified.length + removed.length,
      token_estimate: Math.ceil(diffText.length / 4),
      full_token_estimate: Math.ceil(rawTreeText.length / 4),
      token_savings_ratio: Number(
        (1 - Math.ceil(diffText.length / 4) / Math.max(1, Math.ceil(rawTreeText.length / 4))).toFixed(4)
      ),
      diff_text: diffText,
    };
  }

  /**
   * Rejects a token superseded by another caller-supplied observe in this scope.
   * Live popups and DOM mutations are not automatically observed here.
   */
  verifySnapshotLock({ bundleId, windowId, snapshotId }) {
    const scopeKey = scopeKeyFor({ bundleId, windowId });
    const current = this.sessions.get(scopeKey);
    if (!current || current.snapshotId !== snapshotId) {
      const err = new Error(
        `STALE_SNAPSHOT_LOCK: snapshot_id ${snapshotId} no longer matches active snapshot ${current?.snapshotId || "NONE"} for ${scopeKey}`
      );
      err.code = "STALE_SNAPSHOT_LOCK";
      throw err;
    }
    return true;
  }
}

export class ZeroTokenSkillRuntime {
  constructor({ rpcTransport, snapshotManager = new AXTreeSessionDiffEngine(), skillCacheDir = "./.solidified_skills" } = {}) {
    this.rpcTransport = rpcTransport;
    this.snapshotManager = snapshotManager;
    this.skillCacheDir = skillCacheDir;
    this.activeRun = null;
    // Convenience context for trusted code only; not an isolation boundary.
    this.persistentContext = vm.createContext({
      console,
      setTimeout,
      clearTimeout,
      Promise,
      URL,
      Math,
      JSON,
    });
  }

  /**
   * Requests must carry bundleId, optional windowId, and snapshotId (or
   * snapshot_id) from snapshotManager.observe. Requests are copied and deeply
   * frozen before validation; adapters receive this same JSON-only payload and
   * must honor its scope. The caller's object is never passed to the adapter.
   * Receipt flags are adapter assertions, not independent UI readback by this
   * runtime: ok alone proves neither executed nor verified.
   */
  async dispatch(run, serviceId, request) {
    this.assertRunActive(run);
    if (typeof this.rpcTransport !== "function") {
      throw runtimeError("RPC_TRANSPORT_REQUIRED", "Real dispatch requires an rpcTransport; no simulation fallback is provided");
    }
    if (!request || typeof request !== "object") {
      throw runtimeError("INVALID_ACTION_SCOPE", "RPC requests must include their observed scope and snapshot token");
    }
    const payload = copyFrozenJson(request);
    this.snapshotManager.verifySnapshotLock({
      bundleId: payload.bundleId,
      windowId: payload.windowId,
      snapshotId: payload.snapshotId ?? payload.snapshot_id,
    });
    this.assertRunActive(run);
    // The signal is cooperative: an adapter may ignore it or have sent input.
    const response = await this.rpcTransport(serviceId, payload, { signal: run.controller.signal });
    this.assertRunActive(run);
    if (!response || typeof response !== "object" || typeof response.ok !== "boolean") {
      throw runtimeError("INVALID_TRANSPORT_RESPONSE", "Transport must return a receipt with a boolean ok field");
    }
    if (response.simulated === true) {
      throw runtimeError("SIMULATED_TRANSPORT_RESPONSE", "A simulated receipt cannot establish real execution");
    }
    if (!response.ok) {
      throw Object.assign(runtimeError("RPC_TRANSPORT_FAILED", "Transport reported a failed action"), { receipt: response });
    }
    const receipt = {
      ...response,
      executed: typeof response.executed === "boolean" ? response.executed : null,
      verified: response.executed === true && response.verified === true,
    };
    // Keep aggregation independent of the script-visible response object.
    run.actions.push(Object.freeze({ ok: receipt.ok, executed: receipt.executed, verified: receipt.verified }));
    return receipt;
  }

  assertRunActive(run) {
    if (performance.now() >= run.deadline && !run.stopError) {
      run.stopError = runtimeError("CELL_TIMEOUT", "Cell deadline exceeded; further dispatch is disabled");
      run.controller.abort();
    }
    if (!run.active || run.stopError) {
      throw run.stopError ?? runtimeError("CELL_CLOSED", "Cell has finished; further dispatch is disabled");
    }
  }

  /** Runs reviewed code, with a wall-clock deadline for asynchronous RPC work. */
  async executeCell(code, { timeoutMs = 15000 } = {}) {
    requirePositiveInteger(timeoutMs, "timeoutMs");
    if (this.activeRun) {
      throw runtimeError("RUNTIME_BUSY", "Only one cell may use a runtime at a time");
    }
    const run = {
      active: true, deadline: performance.now() + timeoutMs,
      controller: new AbortController(), pending: [], actions: [], output: [],
    };
    this.activeRun = run;
    // Capture this run in the wrapper so a late continuation cannot dispatch
    // through a subsequent cell's API after its own deadline has expired.
    const cellApi = {
      output: run.output,
      write: (payload) => { this.assertRunActive(run); run.output.push(payload); },
      rpc: (serviceId, request) => {
        const pending = this.dispatch(run, serviceId, request);
        run.pending.push(pending);
        pending.catch(() => {}); // Drain and propagate even unawaited RPC failures below.
        return pending;
      },
    };
    this.persistentContext.nodeRepl = cellApi;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        run.stopError = runtimeError("CELL_TIMEOUT", "Cell deadline exceeded; further dispatch is disabled");
        run.controller.abort();
        reject(run.stopError);
      }, timeoutMs);
    });
    try {
      const wrapped = `(async (nodeRepl) => {\n${code}\n})(nodeRepl)`;
      const script = new vm.Script(wrapped, { filename: "cua-ghost-cell.mjs" });
      const promise = script.runInContext(this.persistentContext, { timeout: timeoutMs });
      const completion = (async () => {
        await promise;
        for (let i = 0; i < run.pending.length; i++) await run.pending[i];
      })();
      await Promise.race([completion, timeout]);
      this.assertRunActive(run);
      return {
        ok: true,
        executed: run.actions.length > 0 && run.actions.every((action) => action.executed === true),
        verified: run.actions.length > 0 && run.actions.every((action) => action.verified === true),
        actions: run.actions,
        llm_tokens_consumed: null,
        token_usage: tokenUsage(),
        outputs: run.output,
      };
    } catch (error) {
      if (error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        throw runtimeError("CELL_TIMEOUT", "Synchronous cell deadline exceeded; further dispatch is disabled");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      run.active = false;
      run.controller.abort();
      this.activeRun = null;
    }
  }

  /**
   * Saves a reusable trusted script; writing a file does not verify its behavior.
   */
  async solidifySkill(skillName, compiledJsCode, metadata = {}) {
    await fs.mkdir(this.skillCacheDir, { recursive: true });
    const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(this.skillCacheDir, `${safeName}.mjs`);
    const header = [
      `// CUA-Ghost trusted-script artifact: ${safeName}`,
      `// Generated At: ${new Date().toISOString()}`,
      `// Runtime model calls: none. External adapter and total token usage: unknown.`,
      `// Metadata: ${JSON.stringify(metadata)}`,
      "",
    ].join("\n");
    await fs.writeFile(filePath, header + compiledJsCode, "utf8");
    return { skillName: safeName, filePath, replayTokenCost: null, verified: false, token_usage: tokenUsage() };
  }

  /**
   * Replays a saved script with the same dispatch guards and unknown adapter cost.
   */
  async replaySolidifiedSkill(skillName, params = {}) {
    if (this.activeRun) {
      throw runtimeError("RUNTIME_BUSY", "Only one cell may use a runtime at a time");
    }
    const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(this.skillCacheDir, `${safeName}.mjs`);
    const code = await fs.readFile(filePath, "utf8");
    if (this.activeRun) {
      throw runtimeError("RUNTIME_BUSY", "Only one cell may use a runtime at a time");
    }
    this.persistentContext.SKILL_PARAMS = params;
    return this.executeCell(code);
  }
}

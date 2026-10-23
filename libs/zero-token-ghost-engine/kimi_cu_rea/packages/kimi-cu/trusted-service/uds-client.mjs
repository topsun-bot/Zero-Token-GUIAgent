import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { KimiCUTarget } from "./target.mjs";

const socketPath = process.env.KIMICU_RUNTIME_SOCKET || `${process.env.HOME}/Library/Application Support/KimiCU/runtime.sock`;
const tokenPath = process.env.KIMICU_RUNTIME_TOKEN_FILE || `${process.env.HOME}/Library/Application Support/KimiCU/runtime.token`;
const approvalTokenPath = process.env.KIMICU_RUNTIME_APPROVAL_TOKEN_FILE;

export class KimiCURuntimeClient {
  constructor({ path = socketPath, tokenFile = tokenPath, approvalTokenFile = approvalTokenPath, approvalToken, observationContext = randomUUID(), timeoutMs = 30_000 } = {}) {
    this.path = path; this.tokenFile = tokenFile; this.approvalTokenFile = approvalTokenFile; this.approvalToken = approvalToken; this.timeoutMs = timeoutMs;
    this.socket = null; this.buffer = Buffer.alloc(0); this.pending = new Map();
    this.sessionId = null; this.capabilities = null; this.methods = []; this.nextId = 0;
    this.connectPromise = null;
    this.observationContext = observationContext;
  }

  async connect() {
    if (this.socket) return;
    if (!this.connectPromise) this.connectPromise = (async () => {
      const token = (await readFile(this.tokenFile, "utf8")).trim();
      if (this.approvalToken === undefined && this.approvalTokenFile) {
        this.approvalToken = (await readFile(this.approvalTokenFile, "utf8")).trim();
      }
      const socket = await new Promise((resolve, reject) => {
        const s = connect(this.path);
        const timer = setTimeout(() => { s.destroy(); reject(new Error("KimiCU runtime socket connect timed out")); }, this.timeoutMs);
        s.once("connect", () => { clearTimeout(timer); resolve(s); });
        s.once("error", (error) => { clearTimeout(timer); reject(error); });
      });
      this.socket = socket;
      socket.on("data", (chunk) => this.#onData(chunk));
      socket.on("error", (error) => this.#fail(error));
      socket.on("close", () => { this.socket = null; this.#fail(new Error("KimiCU runtime socket closed")); });
      try {
        const hello = await this.#request({ type: "hello", token, protocol: "KimiCU-UDS-1", versions: [1], client_name: "kimi-cu-node-repl", observation_context: this.observationContext });
        if (!hello.ok) throw new Error(hello.error || "KimiCU runtime hello failed");
        if (hello.observation_context?.toLowerCase() !== this.observationContext.toLowerCase()) {
          throw new Error("The installed KimiCU service does not support observation contexts; update the service before using this SDK");
        }
        this.sessionId = hello.session_id; this.runtimeVersion = hello.runtime_version || null;
        this.capabilities = hello.capabilities || {};
        this.methods = Array.isArray(hello.methods) ? hello.methods : [];
      } catch (error) {
        // Do not leave an unauthenticated socket around: a subsequent invoke
        // must establish a fresh hello/session rather than reusing a poisoned
        // connection after a token or protocol failure.
        socket.destroy();
        this.socket = null;
        throw error;
      }
    })();
    try { await this.connectPromise; } finally { this.connectPromise = null; }
  }

  async invoke(method, arguments_ = {}, { timeoutMs = this.timeoutMs, deadlineMs, approvalToken = this.approvalToken } = {}) {
    await this.connect();
    const payload = { type: "invoke", request_id: `js-${randomUUID()}`, session_id: this.sessionId, method, arguments: arguments_ };
    if (deadlineMs !== undefined) payload.deadline_ms = deadlineMs;
    if (approvalToken !== undefined) payload.approval_token = approvalToken;
    const result = await this.#request(payload, timeoutMs);
    if (result.ok === false) throw new Error(result.error || `KimiCU action failed: ${method}`);
    const value = result.value || {};
    if (result.attachments?.length) {
      value.attachments = result.attachments;
      value.screenshot = result.attachments.find((a) => a.id === "screenshot");
    }
    return value;
  }

  /** Return a target facade with a stable app/window binding. */
  getApp(app, options = {}) {
    const binding = typeof app === "string" ? { app, ...options } : { ...(app || {}) };
    if (binding.windowId !== undefined && binding.window_id === undefined) binding.window_id = binding.windowId;
    delete binding.windowId;
    return new KimiCUTarget((method, args) => this.invoke(method, args), binding);
  }

  async listApps(args = {}) { return this.invoke("list_apps", args); }
  async listWindows(args = {}) { return this.invoke("list_windows", args); }
  async getWindow(windowOrArgs, options = {}) {
    const args = windowOrArgs && typeof windowOrArgs === "object"
      ? { ...windowOrArgs, ...options }
      : { window_id: windowOrArgs, ...options };
    if (args.windowId !== undefined && args.window_id === undefined) args.window_id = args.windowId;
    delete args.windowId;
    const result = await this.invoke("get_window", args);
    const window = result.window || result;
    if (window && typeof window === "object" && window.id === undefined && window.window_id !== undefined) {
      return { app: window.app, id: window.window_id, ...(window.title ? { title: window.title } : {}) };
    }
    return window;
  }
  async launchApp(app) { return this.invoke("launch_app", { app }); }

  async cancel(requestId) {
    await this.connect();
    const result = await this.#request({ type: "cancel", request_id: requestId, session_id: this.sessionId });
    if (result.error_code && result.error_code !== "cancelled") throw new Error(result.error || "KimiCU runtime cancel failed");
    return result;
  }

  async close() { this.socket?.end(); this.socket = null; this.#fail(new Error("KimiCU runtime closed")); }

  #request(payload, timeoutMs = this.timeoutMs) {
    if (!this.socket?.writable) throw new Error("KimiCU runtime socket is not connected");
    const id = String(++this.nextId);
    const framePayload = Buffer.from(JSON.stringify({ id, ...payload }));
    const frame = Buffer.allocUnsafe(4 + framePayload.length);
    frame.writeUInt32LE(framePayload.length, 0); framePayload.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (payload.type === "invoke" && this.socket?.writable) {
          const cancelPayload = Buffer.from(JSON.stringify({ id: `${id}-cancel`, type: "cancel", request_id: payload.request_id, session_id: payload.session_id }));
          const cancelFrame = Buffer.allocUnsafe(4 + cancelPayload.length); cancelFrame.writeUInt32LE(cancelPayload.length, 0); cancelPayload.copy(cancelFrame, 4); this.socket.write(cancelFrame);
        }
        reject(new Error("KimiCU runtime request timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(frame);
    });
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > 8 * 1024 * 1024) {
        this.#fail(new Error("KimiCU runtime frame exceeds 8 MiB"));
        return;
      }
      if (this.buffer.length < length + 4) return;
      let object;
      try { object = JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8")); }
      catch (error) { this.#fail(new Error(`invalid KimiCU runtime JSON: ${error.message}`)); return; }
      this.buffer = this.buffer.subarray(length + 4);
      const entry = this.pending.get(String(object.id));
      if (!entry) continue;
      this.pending.delete(String(object.id)); clearTimeout(entry.timer); entry.resolve(object);
    }
  }

  #fail(error) { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); } this.pending.clear(); }
}

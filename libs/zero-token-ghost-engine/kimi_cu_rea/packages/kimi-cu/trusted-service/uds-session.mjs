import { FrameDecoder, encodeFrame, failure } from "./wire.mjs";

// vm-safe KimiCU runtime UDS session: the same 4-byte little-endian JSON
// protocol as `node/src/uds-client.mjs` (hello → invoke/cancel), but driven
// over any byte-stream connection with the trusted-worker native-connection
// shape ({ onData, onError, onClose, write, close }). It intentionally uses no
// Node builtins so the trusted worker's vm loader can link it.
export class UdsSession {
  #connection;
  #decoder = new FrameDecoder();
  #pending = new Map();
  #nextId = 0;
  #closed = false;
  #timeoutMs;

  constructor(connection, { timeoutMs = 30_000 } = {}) {
    this.#connection = connection;
    this.#timeoutMs = timeoutMs;
    connection.onData((chunk) => this.#onData(chunk));
    connection.onError((error) => this.#fail(error));
    connection.onClose(() => {
      this.#fail(failure("KIMI_CU_UDS_CLOSED", "KimiCU runtime socket closed"));
    });
  }

  get closed() {
    return this.#closed;
  }

  hello({ token, observationContext, contextMenuOwner, signal } = {}) {
    const payload = {
      type: "hello",
      protocol: "KimiCU-UDS-1",
      versions: [1],
      client_name: "kimi-cu-node-repl",
    };
    if (token !== undefined) payload.token = token;
    if (observationContext !== undefined) payload.observation_context = observationContext;
    if (contextMenuOwner !== undefined) payload.context_menu_owner = contextMenuOwner;
    return this.request(payload, { signal });
  }

  invoke({ sessionId, method, args, deadlineMs, approvalToken, signal } = {}) {
    const requestId = `node-repl-${++this.#nextId}`;
    const payload = {
      type: "invoke",
      request_id: requestId,
      session_id: sessionId,
      method,
      arguments: args,
    };
    if (deadlineMs !== undefined) payload.deadline_ms = deadlineMs;
    if (approvalToken !== undefined) payload.approval_token = approvalToken;
    return this.request(payload, { signal, cancelRequest: { requestId, sessionId } });
  }

  request(payload, { timeoutMs = this.#timeoutMs, signal, cancelRequest } = {}) {
    if (this.#closed) {
      return Promise.reject(
        failure("KIMI_CU_UDS_CLOSED", "KimiCU runtime socket is closed"),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(failure("KIMI_CU_CANCELLED", "KimiCU request was cancelled"));
    }
    const id = String(++this.#nextId);
    const frame = encodeFrame({ id, ...payload });
    return new Promise((resolve, reject) => {
      const entry = { resolve: null, reject: null, timer: null, onAbort: null };
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        this.#pending.delete(id);
        if (entry.timer !== null) clearTimeout(entry.timer);
        if (entry.onAbort) signal?.removeEventListener?.("abort", entry.onAbort);
        callback(value);
      };
      entry.resolve = (value) => settle(resolve, value);
      entry.reject = (error) => settle(reject, error);
      entry.timer = setTimeout(() => {
        this.#sendCancel(cancelRequest);
        settle(reject, failure("KIMI_CU_TIMEOUT", "KimiCU runtime request timed out"));
      }, timeoutMs);
      if (signal) {
        entry.onAbort = () => {
          this.#sendCancel(cancelRequest);
          settle(reject, failure("KIMI_CU_CANCELLED", "KimiCU request was cancelled"));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.#pending.set(id, entry);
      try {
        this.#connection.write(frame);
      } catch (error) {
        settle(reject, error);
      }
    });
  }

  close() {
    if (this.#closed) return;
    try {
      this.#connection.close();
    } catch {
      // The close callback (or the worker's own scope teardown) fails pending.
    }
    this.#fail(failure("KIMI_CU_UDS_CLOSED", "KimiCU runtime socket closed"));
  }

  #sendCancel(cancelRequest) {
    if (!cancelRequest || this.#closed) return;
    try {
      this.#connection.write(encodeFrame({
        id: `cancel-${++this.#nextId}`,
        type: "cancel",
        request_id: cancelRequest.requestId,
        session_id: cancelRequest.sessionId,
      }));
    } catch {
      // Cancellation is best-effort; the pending request is already settled.
    }
  }

  #onData(chunk) {
    let messages;
    try {
      messages = this.#decoder.push(chunk);
    } catch (error) {
      this.#fail(error);
      return;
    }
    for (const message of messages) {
      const entry = this.#pending.get(String(message?.id));
      if (!entry) continue;
      entry.resolve(message);
    }
  }

  #fail(error) {
    if (this.#closed && this.#pending.size === 0) return;
    this.#closed = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.reject(error);
  }
}

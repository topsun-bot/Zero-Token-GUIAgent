import {
  translateArguments,
  validateCodeModeRequest,
  validateServiceConfig,
} from "./schema.mjs";
import { assertRuntimeCompatible } from "./compatibility.mjs";
import { failure } from "./wire.mjs";
import { UdsSession } from "./uds-session.mjs";

const SCREENSHOT_PLACEHOLDER = "[provided as MCP image content]";
const DEV_RUNTIME_VERSION = "0.0.0-dev";

// One lazily connected UDS session per exec (cell); the gate verdict is
// re-evaluated against the cached hello until it passes, and the whole state
// is dropped at exec end so the next cell re-checks. A successful cell may
// hand its already recovered menu to the supervisor generation owner first.
const execStates = new Map();

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestMeta(api) {
  try {
    const value = api.requestMeta;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function lifecycleKey(lifecycle) {
  const cell = isRecord(lifecycle) ? lifecycle.cell : undefined;
  const execId = isRecord(cell) ? cell.exec_id : undefined;
  const nonce = isRecord(cell) ? cell.nonce : undefined;
  return `${String(execId)}${nonce}`;
}

function devRuntimeAllowed(hello, config) {
  if (hello?.runtime_version === DEV_RUNTIME_VERSION) return true;
  if (config.allow_dev_runtime === true) return true;
  try {
    // The trusted-worker vm exposes no `process`; this escape only applies
    // when the module runs in a full Node host (tests, external adapters).
    return (
      typeof process !== "undefined" &&
      process?.env?.KIMI_CU_NODE_REPL_ALLOW_DEV_RUNTIME === "1"
    );
  } catch {
    return false;
  }
}

function enforceRuntimeGate(state, config, api) {
  if (state.gatePassed) return;
  if (devRuntimeAllowed(state.hello, config)) {
    api.write({
      type: "warning",
      message:
        "KimiCU runtime version gate skipped for a development runtime " +
        `(${String(state.hello?.runtime_version ?? "unknown")}); do not use this build as a release baseline`,
    });
    state.gatePassed = true;
    return;
  }
  assertRuntimeCompatible(state.hello, config.minimum_runtime_version);
  state.gatePassed = true;
}

async function connectExecState(api, config) {
  // Cancellation runs outside the request scope; retain its signal, not the getter.
  const signal = api.signal;
  const connection = await api.nativePipe.createExecConnection(config.endpoint);
  const session = new UdsSession(connection, { timeoutMs: config.timeout_ms ?? 30_000 });
  try {
    const hello = await session.hello({ token: config.token, observationContext: config.observation_context, contextMenuOwner: config.context_menu_owner, signal });
    if (!isRecord(hello) || hello.ok !== true) {
      throw failure(
        (isRecord(hello) && typeof hello.error_code === "string" && hello.error_code) ||
          "KIMI_CU_RUNTIME_HELLO_FAILED",
        (isRecord(hello) && typeof hello.error === "string" && hello.error) ||
          "KimiCU runtime rejected the UDS hello; no CU operation was started",
      );
    }
    if (config.observation_context !== undefined &&
        hello.observation_context?.toLowerCase() !== config.observation_context.toLowerCase()) {
      throw failure("KIMI_CU_OBSERVATION_CONTEXT_UNSUPPORTED",
        "The installed service does not support shared observation contexts; update the service and reconnect MCP before using this JS bridge");
    }
    if (config.context_menu_owner !== undefined && hello.capabilities?.context_menu_handoff !== true) {
      throw failure("KIMI_CU_MENU_HANDOFF_UNSUPPORTED", "Runtime does not support the supervisor's context menu lifetime; reconnect after updating it");
    }
    return { session, hello, gatePassed: false, menuOwner: config.context_menu_owner };
  } catch (error) {
    session.close();
    throw error;
  }
}

function ensureExecState(api, config) {
  const key = lifecycleKey(api.lifecycle);
  let state = execStates.get(key);
  if (state?.settled && !state.value.session.closed) return state.value;
  if (!state || state.settled) {
    state = { settled: false, promise: null, value: null };
    state.promise = connectExecState(api, config).then(
      (value) => {
        state.value = value;
        state.settled = true;
        return value;
      },
      (error) => {
        state.settled = true;
        if (execStates.get(key) === state) execStates.delete(key);
        throw error;
      },
    );
    execStates.set(key, state);
  }
  return state.promise;
}

function validateInvokeResponse(response, method) {
  if (!isRecord(response)) {
    throw failure("KIMI_CU_INVALID_RESPONSE", `KimiCU runtime ${method} response must be an object`);
  }
  if (typeof response.ok !== "boolean") {
    throw failure("KIMI_CU_INVALID_RESPONSE", `KimiCU runtime ${method} response.ok must be a boolean`);
  }
  if (!response.ok) return response;
  if (response.attachments !== undefined && !Array.isArray(response.attachments)) {
    throw failure("KIMI_CU_INVALID_RESPONSE", `KimiCU runtime ${method} attachments must be an array`);
  }
  return response;
}

// The trusted worker re-checks every emitted image (normalizeMedia/safeBase64)
// and rejects the whole RPC mid-loop on the first bad attachment, leaking the
// images emitted before it. Validate the full set up front — same rules as
// the worker — so a bad attachment fails the RPC with zero images emitted.
function validateAttachments(attachments) {
  for (const attachment of attachments) {
    if (!isRecord(attachment) || typeof attachment.data_base64 !== "string") {
      throw failure(
        "KIMI_CU_INVALID_RESPONSE",
        "each KimiCU runtime attachment must carry base64 data",
      );
    }
    if (typeof attachment.mime_type === "string" && attachment.mime_type.length === 0) {
      throw failure(
        "INVALID_CONTENT_ITEM",
        "KimiCU runtime attachment mime type must be non-empty",
      );
    }
    if (Buffer.from(attachment.data_base64, "base64").toString("base64") !== attachment.data_base64) {
      throw failure(
        "INVALID_CONTENT_ITEM",
        "KimiCU runtime attachment data_base64 must be canonical base64 text",
      );
    }
  }
}

function emitAttachments(response, api) {
  const value = response.value ?? {};
  const attachments = response.attachments ?? [];
  validateAttachments(attachments);
  let count = 0;
  let bytes = 0;
  const scrubbedAttachments = [];
  for (const attachment of attachments) {
    api.emitImage({
      mimeType: typeof attachment.mime_type === "string" ? attachment.mime_type : "image/jpeg",
      data: attachment.data_base64,
    });
    count += 1;
    bytes += Buffer.from(attachment.data_base64, "base64").length;
    scrubbedAttachments.push({ ...attachment, data_base64: SCREENSHOT_PLACEHOLDER });
  }
  const result = structuredClone(value);
  if (count > 0 && isRecord(result)) {
    if (result.screenshot !== undefined) result.screenshot = SCREENSHOT_PLACEHOLDER;
    if (result.attachments !== undefined) result.attachments = scrubbedAttachments;
    if (typeof result.image_base64 === "string") result.image_base64 = SCREENSHOT_PLACEHOLDER;
  }
  return { result, count, bytes };
}

export async function handleRpc(rawRequest, api = nodeRepl) {
  const request = validateCodeModeRequest(rawRequest);
  const config = validateServiceConfig(api.serviceConfig);
  const state = await ensureExecState(api, config);
  enforceRuntimeGate(state, config, api);
  const method = request.method;
  const args = translateArguments(method, request.arguments);
  const response = validateInvokeResponse(
    await state.session.invoke({
      sessionId: state.hello.session_id,
      method,
      args,
      approvalToken: config.approval_token,
      signal: api.signal,
    }),
    method,
  );
  if (!response.ok) {
    throw failure(
      (typeof response.error_code === "string" && response.error_code) || "KIMI_CU_AGENT_ERROR",
      (typeof response.error === "string" && response.error) || `KimiCU runtime ${method} failed`,
    );
  }
  const meta = requestMeta(api);
  const emitted = emitAttachments(response, api);
  api.setResponseMeta({
    "kimi/cu": {
      method,
      image_count: emitted.count,
      image_bytes: emitted.bytes,
      request_meta_present: Object.keys(meta).length > 0,
    },
  });
  return emitted.result;
}

export async function handleExecEnd(outcome, api = nodeRepl) {
  const key = lifecycleKey(api.lifecycle);
  const state = execStates.get(key);
  if (!state) return;
  execStates.delete(key);
  let value;
  try { value = await state.promise; } catch { return; }
  try {
    if (value.menuOwner !== undefined && !value.session.closed) {
      const response = await value.session.request({ type: "finish_cell",
        session_id: value.hello.session_id, preserve_context_menu: outcome?.status === "success" },
        { timeoutMs: 1000 });
      if (response.ok !== true) throw failure("KIMI_CU_MENU_HANDOFF_FAILED", "Context menu lifetime handoff failed");
    }
  } finally { value.session.close(); }
}

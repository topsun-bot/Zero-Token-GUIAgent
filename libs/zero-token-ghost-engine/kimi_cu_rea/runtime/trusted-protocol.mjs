export const PROTOCOL_VERSION = 1;

export const MESSAGE_TYPE = Object.freeze({
  EXEC_START: "exec_start",
  EXEC_END: "exec_end",
  SERVICE: "service",
  SHUTDOWN: "shutdown",
  NATIVE_PIPE_OPENED: "native_pipe_opened",
  NATIVE_PIPE_DATA: "native_pipe_data",
  NATIVE_PIPE_CLOSED: "native_pipe_closed",
  TRUSTED_WORKER_READY: "trusted_worker_ready",
  TRUSTED_EXEC_STARTED: "trusted_exec_started",
  TRUSTED_EXEC_ENDED: "trusted_exec_ended",
  NATIVE_PIPE_OPEN: "native_pipe_open",
  NATIVE_PIPE_WRITE: "native_pipe_write",
  NATIVE_PIPE_CLOSE: "native_pipe_close",
  TRUSTED_SERVICE_RESPONSE: "trusted_service_response",
});

export class TrustedProtocolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "TrustedProtocolError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function protocolError(code, message, details) {
  return new TrustedProtocolError(code, message, details);
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("INVALID_PROTOCOL_MESSAGE", `${label} must be an object`);
  }
  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw protocolError("INVALID_PROTOCOL_MESSAGE", `${label} must be an array`);
  }
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw protocolError("INVALID_PROTOCOL_MESSAGE", `${label} must be a non-empty string`);
  }
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw protocolError("INVALID_PROTOCOL_MESSAGE", `${label} must be a boolean`);
  }
  return value;
}

function assertStableIdentifier(value, label) {
  assertString(value, label);
  if (value.length > 512 || value.includes("\0")) {
    throw protocolError("INVALID_PROTOCOL_MESSAGE", `${label} must be a stable identifier`);
  }
  return value;
}

function validateCellIdentity(cell, execId) {
  assertObject(cell, "lifecycle.cell");
  assertStableIdentifier(cell.session_id, "lifecycle.cell.session_id");
  const generation = String(cell.generation ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(generation)) {
    throw protocolError(
      "INVALID_PROTOCOL_MESSAGE",
      "lifecycle.cell.generation must be a stable identifier",
    );
  }
  assertStableIdentifier(cell.exec_id, "lifecycle.cell.exec_id");
  if (cell.exec_id !== execId) {
    throw protocolError(
      "LIFECYCLE_OWNER_MISMATCH",
      "lifecycle.cell.exec_id does not match message.exec_id",
    );
  }
  assertStableIdentifier(cell.nonce, "lifecycle.cell.nonce");
  return cell;
}

export function validateLifecycleIdentity(lifecycle, execId) {
  assertObject(lifecycle, "lifecycle");
  if (lifecycle.kind !== "host_turn" && lifecycle.kind !== "synthetic_cell") {
    throw protocolError(
      "INVALID_LIFECYCLE_IDENTITY",
      "lifecycle.kind must be host_turn or synthetic_cell",
    );
  }
  validateCellIdentity(lifecycle.cell, execId);
  if (lifecycle.kind === "host_turn") {
    assertObject(lifecycle.host, "lifecycle.host");
    assertStableIdentifier(lifecycle.host.session_id, "lifecycle.host.session_id");
    assertStableIdentifier(lifecycle.host.turn_id, "lifecycle.host.turn_id");
  } else if (lifecycle.host !== undefined) {
    throw protocolError(
      "INVALID_LIFECYCLE_IDENTITY",
      "synthetic_cell lifecycle must not contain host metadata",
    );
  }
  return lifecycle;
}

export function assertProtocolHeader(message) {
  assertObject(message, "message");
  if (message.version !== PROTOCOL_VERSION) {
    throw protocolError(
      "UNSUPPORTED_PROTOCOL_VERSION",
      `expected protocol version ${PROTOCOL_VERSION}, got ${String(message.version)}`,
    );
  }
  assertString(message.type, "message.type");
  return message;
}

export function validateServiceId(service) {
  assertString(service, "service");
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(service)) {
    throw protocolError(
      "INVALID_SERVICE_ID",
      `invalid trusted service id: ${service}`,
    );
  }
  return service;
}

export function operationKey(execId, operationId) {
  return `${assertString(execId, "exec_id")}\0${assertString(operationId, "operation_id")}`;
}

function validateOperationOwner(message) {
  assertString(message.exec_id, "exec_id");
  assertString(message.operation_id, "operation_id");
  return message;
}

function validateConnectionOwner(message) {
  validateOperationOwner(message);
  assertString(message.connection_id, "connection_id");
  return message;
}

function assertBase64(value, label) {
  if (typeof value !== "string" || value.length % 4 !== 0) {
    throw protocolError("INVALID_PROTOCOL_MESSAGE", `${label} must be canonical base64`);
  }
  if (value !== "" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw protocolError("INVALID_PROTOCOL_MESSAGE", `${label} must be canonical base64`);
  }
  return value;
}

export function validateSupervisorToTrustedMessage(message) {
  assertProtocolHeader(message);
  switch (message.type) {
    case MESSAGE_TYPE.EXEC_START:
      assertString(message.exec_id, "exec_id");
      validateLifecycleIdentity(message.lifecycle, message.exec_id);
      assertObject(message.request_meta, "request_meta");
      break;
    case MESSAGE_TYPE.EXEC_END:
      assertString(message.exec_id, "exec_id");
      assertStableIdentifier(message.lifecycle_nonce, "lifecycle_nonce");
      assertObject(message.outcome, "outcome");
      assertStableIdentifier(message.outcome.status, "outcome.status");
      if (message.outcome.reason !== undefined) {
        if (typeof message.outcome.reason !== "string") {
          throw protocolError("INVALID_PROTOCOL_MESSAGE", "outcome.reason must be a string");
        }
      }
      break;
    case MESSAGE_TYPE.SERVICE:
      validateOperationOwner(message);
      validateServiceId(message.service);
      assertObject(message.request, "request");
      assertObject(message.request_meta, "request_meta");
      break;
    case MESSAGE_TYPE.NATIVE_PIPE_OPENED:
      validateConnectionOwner(message);
      break;
    case MESSAGE_TYPE.NATIVE_PIPE_DATA:
      validateConnectionOwner(message);
      assertBase64(message.data_base64, "data_base64");
      break;
    case MESSAGE_TYPE.NATIVE_PIPE_CLOSED:
      validateConnectionOwner(message);
      if (message.error !== null && message.error !== undefined) {
        if (typeof message.error === "string") assertString(message.error, "error");
        else validateErrorPayload(message.error);
      }
      break;
    case MESSAGE_TYPE.SHUTDOWN:
      break;
    default:
      throw protocolError(
        "UNEXPECTED_PROTOCOL_MESSAGE",
        `trusted worker cannot accept message type: ${message.type}`,
      );
  }
  return message;
}

export function validateTrustedToSupervisorMessage(message) {
  assertProtocolHeader(message);
  switch (message.type) {
    case MESSAGE_TYPE.TRUSTED_WORKER_READY:
      break;
    case MESSAGE_TYPE.TRUSTED_EXEC_STARTED:
    case MESSAGE_TYPE.TRUSTED_EXEC_ENDED:
      assertString(message.exec_id, "exec_id");
      assertStableIdentifier(message.lifecycle_nonce, "lifecycle_nonce");
      assertBoolean(message.applied, "applied");
      break;
    case MESSAGE_TYPE.NATIVE_PIPE_OPEN:
      validateConnectionOwner(message);
      assertString(message.path, "path");
      break;
    case MESSAGE_TYPE.NATIVE_PIPE_WRITE:
      validateConnectionOwner(message);
      assertBase64(message.data_base64, "data_base64");
      break;
    case MESSAGE_TYPE.NATIVE_PIPE_CLOSE:
      validateConnectionOwner(message);
      break;
    case MESSAGE_TYPE.TRUSTED_SERVICE_RESPONSE:
      validateOperationOwner(message);
      assertBoolean(message.ok, "ok");
      assertArray(message.output, "output");
      assertArray(message.content_items, "content_items");
      assertObject(message.response_meta, "response_meta");
      if (!message.ok) validateErrorPayload(message.error);
      break;
    default:
      throw protocolError(
        "UNEXPECTED_PROTOCOL_MESSAGE",
        `supervisor cannot accept trusted worker message type: ${message.type}`,
      );
  }
  return message;
}

export function validateErrorPayload(error) {
  assertObject(error, "error");
  assertString(error.code, "error.code");
  assertString(error.message, "error.message");
  return error;
}

export function jsonValue(value, label = "value") {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw protocolError("NON_JSON_VALUE", `${label} is not JSON-serializable: ${error.message}`);
  }
  if (encoded === undefined) {
    throw protocolError("NON_JSON_VALUE", `${label} is not JSON-serializable`);
  }
  return JSON.parse(encoded);
}

export function errorPayload(error, fallbackCode = "TRUSTED_SERVICE_ERROR") {
  const payload = {
    code:
      typeof error?.code === "string" && error.code.length > 0
        ? error.code
        : fallbackCode,
    message: error?.message ? String(error.message) : String(error),
    name: error?.name ? String(error.name) : "Error",
  };
  if (error?.details !== undefined) {
    try {
      payload.details = jsonValue(error.details, "error.details");
    } catch {
      // An error must remain reportable even when its optional details are not JSON.
    }
  }
  return payload;
}

export function trustedServiceResponse({
  execId,
  operationId,
  ok,
  value,
  error,
  output = [],
  contentItems = [],
  responseMeta = {},
}) {
  const message = {
    version: PROTOCOL_VERSION,
    type: MESSAGE_TYPE.TRUSTED_SERVICE_RESPONSE,
    exec_id: assertString(execId, "exec_id"),
    operation_id: assertString(operationId, "operation_id"),
    ok: Boolean(ok),
    output: jsonValue(output, "output"),
    content_items: jsonValue(contentItems, "content_items"),
    response_meta: jsonValue(responseMeta, "response_meta"),
  };
  if (ok) message.value = jsonValue(value, "value");
  else message.error = errorPayload(error);
  validateTrustedToSupervisorMessage(message);
  return message;
}

export function nativePipeMessage(type, owner, fields = {}) {
  const message = {
    version: PROTOCOL_VERSION,
    type,
    exec_id: assertString(owner.execId, "exec_id"),
    operation_id: assertString(owner.operationId, "operation_id"),
    connection_id: assertString(owner.connectionId, "connection_id"),
    ...fields,
  };
  validateTrustedToSupervisorMessage(message);
  return message;
}

function normalizeNamedPipePath(value) {
  const path = assertString(value, "named pipe path").replaceAll("/", "\\");
  if (!/^\\\\\.\\pipe\\[^\0]+$/i.test(path)) {
    throw protocolError("INVALID_NATIVE_PIPE_PATH", `not a Windows named pipe path: ${value}`);
  }
  return path;
}

export function createNativePipePolicy(config = {}) {
  const exact = config.allowed_paths ?? config.allowedPaths ?? [];
  const prefixes = config.allowed_prefixes ?? config.allowedPrefixes ?? [];
  if (!Array.isArray(exact) || !Array.isArray(prefixes)) {
    throw protocolError(
      "INVALID_NATIVE_PIPE_POLICY",
      "native pipe allowed paths and prefixes must be arrays",
    );
  }
  const normalize = (entry) => normalizeNamedPipePath(entry).toLowerCase();
  return Object.freeze({
    allowedPaths: Object.freeze(exact.map(normalize)),
    allowedPrefixes: Object.freeze(prefixes.map(normalize)),
  });
}

export function assertAllowedNamedPipePath(value, policy) {
  const normalized = normalizeNamedPipePath(value);
  const folded = normalized.toLowerCase();
  if (
    !policy.allowedPaths.includes(folded) &&
    !policy.allowedPrefixes.some((prefix) => folded.startsWith(prefix))
  ) {
    throw protocolError(
      "NATIVE_PIPE_PATH_NOT_ALLOWED",
      `named pipe path is outside the startup allowlist: ${value}`,
    );
  }
  return normalized;
}

export class OperationTombstones {
  #limit;
  #set = new Set();

  constructor(limit = 1_024) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw protocolError("INVALID_TOMBSTONE_LIMIT", "tombstone limit must be a positive integer");
    }
    this.#limit = limit;
  }

  add(key) {
    this.#set.delete(key);
    this.#set.add(key);
    while (this.#set.size > this.#limit) {
      this.#set.delete(this.#set.values().next().value);
    }
  }

  has(key) {
    return this.#set.has(key);
  }

  get size() {
    return this.#set.size;
  }
}

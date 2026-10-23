export const PROTOCOL_VERSION = 1;

export const SupervisorToKernel = Object.freeze({
  EXEC: 'exec',
  CANCEL_EXEC: 'cancel_exec',
  TRUSTED_SERVICE_RESPONSE: 'trusted_service_response',
  SHUTDOWN: 'shutdown',
});

export const KernelToSupervisor = Object.freeze({
  KERNEL_READY: 'kernel_ready',
  TRUSTED_SERVICE_REQUEST: 'trusted_service_request',
  EXEC_RESULT: 'exec_result',
  SUBMITTED_CODE_COMPLETE: 'submitted_code_complete',
});

export class KernelProtocolError extends Error {
  constructor(message, code = 'INVALID_PROTOCOL_MESSAGE', details) {
    super(message);
    this.name = 'KernelProtocolError';
    this.code = code;
    this.details = details;
  }
}

export function protocolMessage(type, fields = {}) {
  if (typeof type !== 'string' || type.length === 0) {
    throw new KernelProtocolError('Protocol message type must be a non-empty string');
  }
  return { version: PROTOCOL_VERSION, type, ...fields };
}

export function parseProtocolLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    throw new KernelProtocolError(`Invalid protocol JSON: ${error.message}`, 'INVALID_JSON');
  }
  return validateProtocolMessage(message);
}

export function serializeProtocolMessage(message) {
  validateProtocolMessage(message);
  try {
    return JSON.stringify(message);
  } catch (error) {
    throw new KernelProtocolError(
      `Protocol message is not JSON serializable: ${error.message}`,
      'UNSERIALIZABLE_PROTOCOL_MESSAGE',
    );
  }
}

export function validateProtocolMessage(message) {
  if (!isRecord(message)) {
    throw new KernelProtocolError('Protocol message must be an object');
  }
  if (message.version !== PROTOCOL_VERSION) {
    throw new KernelProtocolError(
      `Unsupported protocol version: ${String(message.version)}`,
      'UNSUPPORTED_PROTOCOL_VERSION',
    );
  }
  if (typeof message.type !== 'string' || message.type.length === 0) {
    throw new KernelProtocolError('Protocol message type must be a non-empty string');
  }
  return message;
}

export function validateExecMessage(message) {
  validateProtocolMessage(message);
  if (message.type !== SupervisorToKernel.EXEC) {
    throw new KernelProtocolError(`Expected exec, received ${message.type}`);
  }
  requireIdentifier(message.exec_id, 'exec_id');
  if (typeof message.code !== 'string') {
    throw new KernelProtocolError('exec.code must be a string');
  }
  if (!Number.isInteger(message.timeout_ms) || message.timeout_ms <= 0) {
    throw new KernelProtocolError('exec.timeout_ms must be a positive integer');
  }
  if (!isRecord(message.request_meta)) {
    throw new KernelProtocolError('exec.request_meta must be an object');
  }
  return message;
}

export function validateCancelMessage(message) {
  validateProtocolMessage(message);
  if (message.type !== SupervisorToKernel.CANCEL_EXEC) {
    throw new KernelProtocolError(`Expected cancel_exec, received ${message.type}`);
  }
  requireIdentifier(message.exec_id, 'exec_id');
  if (message.reason !== undefined && typeof message.reason !== 'string') {
    throw new KernelProtocolError('cancel_exec.reason must be a string when present');
  }
  return message;
}

export function validateTrustedServiceResponse(message) {
  validateProtocolMessage(message);
  if (message.type !== SupervisorToKernel.TRUSTED_SERVICE_RESPONSE) {
    throw new KernelProtocolError(
      `Expected trusted_service_response, received ${message.type}`,
    );
  }
  requireIdentifier(message.exec_id, 'exec_id');
  requireIdentifier(message.operation_id, 'operation_id');
  if (typeof message.ok !== 'boolean') {
    throw new KernelProtocolError('trusted_service_response.ok must be a boolean');
  }
  if (message.output !== undefined && !Array.isArray(message.output)) {
    throw new KernelProtocolError('trusted_service_response.output must be an array');
  }
  if (message.content_items !== undefined && !Array.isArray(message.content_items)) {
    throw new KernelProtocolError('trusted_service_response.content_items must be an array');
  }
  if (message.response_meta !== undefined && !isRecord(message.response_meta)) {
    throw new KernelProtocolError('trusted_service_response.response_meta must be an object');
  }
  if (!message.ok && !isRecord(message.error)) {
    throw new KernelProtocolError('failed trusted_service_response.error must be an object');
  }
  return message;
}

export function errorRecord(error, fallbackCode = 'EXEC_ERROR') {
  return {
    code: typeof error?.code === 'string' ? error.code : fallbackCode,
    message: typeof error?.message === 'string' ? error.message : String(error),
  };
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireIdentifier(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new KernelProtocolError(`${name} must be a non-empty string`);
  }
}

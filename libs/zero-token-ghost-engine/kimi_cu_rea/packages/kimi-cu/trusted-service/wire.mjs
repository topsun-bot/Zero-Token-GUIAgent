// KimiCU macOS runtime UDS wire format: a 32-bit little-endian byte length
// followed by one UTF-8 JSON value, matching `node/src/uds-client.mjs`.
// One long-lived connection carries many
// frames, so the decoder streams and returns every message it completes.
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function encodeFrame(value) {
  let payload;
  try {
    payload = Buffer.from(JSON.stringify(value), "utf8");
  } catch (error) {
    throw failure(
      "KIMI_CU_REQUEST_NOT_SERIALIZABLE",
      `request is not JSON serializable: ${error.message}`,
    );
  }
  if (payload.length > MAX_FRAME_BYTES) {
    throw failure(
      "KIMI_CU_FRAME_TOO_LARGE",
      `frame length ${payload.length} exceeds ${MAX_FRAME_BYTES}`,
    );
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  #buffer = Buffer.alloc(0);

  get bufferedBytes() {
    return this.#buffer.length;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk) && !ArrayBuffer.isView(chunk)) {
      throw failure("KIMI_CU_INVALID_FRAME_CHUNK", "response chunks must be binary data");
    }
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.#buffer =
      this.#buffer.length === 0 ? incoming : Buffer.concat([this.#buffer, incoming]);
    const messages = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        throw failure(
          "KIMI_CU_FRAME_TOO_LARGE",
          `frame length ${length} exceeds ${MAX_FRAME_BYTES}`,
        );
      }
      if (this.#buffer.length < length + 4) break;
      let message;
      try {
        message = JSON.parse(this.#buffer.subarray(4, length + 4).toString("utf8"));
      } catch (error) {
        throw failure("KIMI_CU_INVALID_FRAME_JSON", `invalid framed JSON: ${error.message}`);
      }
      this.#buffer = this.#buffer.subarray(length + 4);
      messages.push(message);
    }
    return messages;
  }
}

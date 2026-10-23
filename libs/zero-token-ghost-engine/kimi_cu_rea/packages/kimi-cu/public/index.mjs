const SERVICE_ID = "kimi-cu";

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runtimeRpc() {
  const candidate = globalThis.nodeRepl;
  if (!candidate || typeof candidate.rpc !== "function") {
    throw failure(
      "KIMI_CU_RUNTIME_UNAVAILABLE",
      "@kimi/cu requires the Kimi NodeRepl runtime",
    );
  }
  return candidate.rpc;
}

function callMethod(method, args = {}) {
  if (!isRecord(args)) {
    throw failure(
      "INVALID_KIMI_CU_ARGUMENTS",
      `${method} arguments must be an object`,
    );
  }
  return runtimeRpc()(SERVICE_ID, {
    version: 1,
    method,
    arguments: args,
  });
}

function list_apps(input) {
  return callMethod("list_apps", input);
}

function list_windows(input) {
  return callMethod("list_windows", input);
}

function get_window(input) {
  return callMethod("get_window", input);
}

function launch_app(input) {
  return callMethod("launch_app", input);
}

function get_app_state(input) {
  return callMethod("get_app_state", input);
}

function get_window_state(input) {
  return callMethod("get_window_state", input);
}

function activate_window(input) {
  return callMethod("activate_window", input);
}

function click(input) {
  return callMethod("click", input);
}

function type_text(input) {
  return callMethod("type_text", input);
}

function press_key(input) {
  return callMethod("press_key", input);
}

function scroll(input) {
  return callMethod("scroll", input);
}

function set_value(input) {
  return callMethod("set_value", input);
}

function perform_secondary_action(input) {
  return callMethod("perform_secondary_action", input);
}

function select_text(input) {
  return callMethod("select_text", input);
}

function drag(input) {
  return callMethod("drag", input);
}

function paste(input) {
  return callMethod("paste", input);
}

function drag_paths(input) {
  return callMethod("drag_paths", input);
}

/** macOS KimiCU code-mode facade. The legacy MCP remains a separate adapter. */
export const kimiCU = Object.freeze({
  target: "mac",
  list_apps,
  list_windows,
  get_window,
  launch_app,
  get_app_state,
  get_window_state,
  activate_window,
  click,
  type_text,
  press_key,
  scroll,
  set_value,
  perform_secondary_action,
  select_text,
  drag,
  paste,
  drag_paths,
});

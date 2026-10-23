import { METHODS, ARGUMENT_ALIASES } from "./tool-catalog.mjs";
import { failure } from "./wire.mjs";
import { validateMinimumRuntimeVersion } from "./compatibility.mjs";

// Compatible facade vocabulary for the macOS ToolName surface. Validation
// stays strict (exact keys, unknown-field rejection, window object shape);
// `translateArguments` then maps the accepted aliases onto the native macOS
// ToolRouter fields before invoke.
const MOUSE_BUTTONS = Object.freeze(["left", "right", "middle", "l", "r", "m"]);
const APP_STATE_MODES = Object.freeze(["full", "image", "ax"]);
const PASTE_FORMATS = Object.freeze(["text", "md", "html"]);
const SELECTION_TYPES = Object.freeze(["text", "cursor_before", "cursor_after"]);

const MAX_DRAG_PATHS = 500;
const MAX_PATH_POINTS = 1024;

// Integer ranges mirror the Swift ToolRouter argument types (ToolTypes.swift)
// so out-of-range values are rejected here with a field name instead of
// surfacing as a late JSONDecoder error.
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const UINT32_MAX = 4_294_967_295;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) {
    throw failure("KIMI_CU_INVALID_REQUEST", `${label} must be an object`);
  }
}

function assertExactKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw failure("KIMI_CU_UNKNOWN_FIELD", `${label} contains unknown field: ${key}`);
    }
  }
}

function assertString(value, label, { nonempty = true } = {}) {
  if (typeof value !== "string" || (nonempty && value.length === 0)) {
    throw failure(
      "KIMI_CU_INVALID_ARGUMENT",
      `${label} must be a${nonempty ? " non-empty" : ""} string`,
    );
  }
}

function assertInteger(value, label, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw failure(
      "KIMI_CU_INVALID_ARGUMENT",
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw failure("KIMI_CU_INVALID_ARGUMENT", `${label} must be a boolean`);
  }
}

function assertNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw failure("KIMI_CU_INVALID_ARGUMENT", `${label} must be a finite number`);
  }
}

function assertEnum(value, label, options) {
  assertString(value, label);
  if (!options.includes(value)) {
    throw failure(
      "KIMI_CU_INVALID_ARGUMENT",
      `${label} must be one of: ${options.join(", ")}`,
    );
  }
}

function validateWindow(value, label) {
  assertRecord(value, label);
  assertExactKeys(value, ["app", "id", "title"], label);
  assertString(value.app, `${label}.app`);
  assertInteger(value.id, `${label}.id`, 1, UINT32_MAX);
  if (value.title !== undefined) {
    assertString(value.title, `${label}.title`, { nonempty: false });
  }
}

function validatePointOrIndex(args, label, { optional = false } = {}) {
  const hasIndex = args.element_index !== undefined || args.index !== undefined;
  const hasX = args.x !== undefined;
  const hasY = args.y !== undefined;
  if (hasX !== hasY || (hasIndex && hasX) || (!optional && !hasIndex && !hasX)) {
    throw failure(
      "KIMI_CU_INVALID_TARGET",
      optional
        ? `${label} accepts no explicit target, element_index, or an x/y pair, but not mixed or partial targets`
        : `${label} requires element_index or an x/y pair, but not both`,
    );
  }
}

function validateTarget(method, args) {
  // Flat targeting (app / pid / window_id) is as valid as the {app,id,title}
  // window object — the facade must not force one style per method
  // (2026-09-19 agent report: get_app_state took window_id but click rejected
  // it, same-facade style inconsistency).
  if (args.window === undefined && args.app === undefined && args.pid === undefined
      && args.window_id === undefined) {
    throw failure(
      "KIMI_CU_MISSING_ARGUMENT",
      `${method} requires a window object, an app, a pid, or a window_id`,
    );
  }
}

function validateDragPaths(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DRAG_PATHS) {
    throw failure(
      "KIMI_CU_INVALID_ARGUMENT",
      `${label} must be an array of 1..${MAX_DRAG_PATHS} paths`,
    );
  }
  for (const [index, item] of value.entries()) {
    const itemLabel = `${label}[${index}]`;
    assertRecord(item, itemLabel);
    assertExactKeys(item, ["points", "steps", "hold_ms", "step_ms"], itemLabel);
    if (!Array.isArray(item.points) || item.points.length < 2 || item.points.length > MAX_PATH_POINTS) {
      throw failure(
        "KIMI_CU_INVALID_ARGUMENT",
        `${itemLabel}.points must be an array of 2..${MAX_PATH_POINTS} points`,
      );
    }
    for (const [pointIndex, point] of item.points.entries()) {
      if (!Array.isArray(point) || point.length !== 2) {
        throw failure(
          "KIMI_CU_INVALID_ARGUMENT",
          `${itemLabel}.points[${pointIndex}] must be an [x, y] pair`,
        );
      }
      assertNumber(point[0], `${itemLabel}.points[${pointIndex}][0]`);
      assertNumber(point[1], `${itemLabel}.points[${pointIndex}][1]`);
    }
    if (item.steps !== undefined) assertInteger(item.steps, `${itemLabel}.steps`, 1, MAX_DRAG_PATHS);
    if (item.hold_ms !== undefined) assertInteger(item.hold_ms, `${itemLabel}.hold_ms`, 0, 1000);
    if (item.step_ms !== undefined) assertInteger(item.step_ms, `${itemLabel}.step_ms`, 0, 100);
  }
}

function validateTypes(method, args) {
  if (args.window !== undefined) validateWindow(args.window, `${method}.window`);
  for (const key of ["snapshot_id", "app", "key", "keys", "action", "screenshotId", "screenshot_id", "ax_filter", "prefix", "suffix"]) {
    if (args[key] !== undefined) assertString(args[key], `${method}.${key}`);
  }
  for (const key of ["text", "value"]) {
    if (args[key] !== undefined) {
      if (method === "select_text") assertString(args[key], `${method}.${key}`);
      else assertString(args[key], `${method}.${key}`, { nonempty: false });
    }
  }
  if (args.window_id !== undefined) assertInteger(args.window_id, `${method}.window_id`, 1, UINT32_MAX);
  if (args.id !== undefined) assertInteger(args.id, `${method}.id`, 1, UINT32_MAX);
  if (args.pid !== undefined) assertInteger(args.pid, `${method}.pid`, 1, INT32_MAX);
  if (args.element_index !== undefined) assertInteger(args.element_index, `${method}.element_index`, 0);
  if (args.index !== undefined) assertInteger(args.index, `${method}.index`, 0);
  if (args.count !== undefined) assertInteger(args.count, `${method}.count`, 1, 3);
  if (args.click_count !== undefined) assertInteger(args.click_count, `${method}.click_count`, 1, 3);
  if (args.start !== undefined) assertInteger(args.start, `${method}.start`, 0);
  if (args.length !== undefined) assertInteger(args.length, `${method}.length`, 0);
  if (args.hover_ms !== undefined) assertInteger(args.hover_ms, `${method}.hover_ms`, 0, 1000);
  if (args.hold_ms !== undefined) assertInteger(args.hold_ms, `${method}.hold_ms`, 0, method === "click" ? 500 : 1000);
  if (args.step_ms !== undefined) assertInteger(args.step_ms, `${method}.step_ms`, 0, 100);
  if (args.steps !== undefined) assertInteger(args.steps, `${method}.steps`, 1, 500);
  for (const key of ["page", "dx", "dy"]) {
    if (args[key] !== undefined) assertInteger(args[key], `${method}.${key}`, INT32_MIN, INT32_MAX);
  }
  for (const key of ["x", "y"]) {
    if (args[key] !== undefined) assertNumber(args[key], `${method}.${key}`);
  }
  for (const key of ["from_x", "from_y", "to_x", "to_y"]) {
    if (args[key] !== undefined) assertNumber(args[key], `${method}.${key}`);
  }
  for (const key of [
    "running_only",
    "include_screenshot",
    "include_text",
    "clear",
    "submit",
    "activate",
    "verify_after",
    "allow_foreground_fallback",
    "autosubmit",
    "disableDiff",
    "disable_diff",
    "abort_if_cursor_in_window",
  ]) {
    if (args[key] !== undefined) assertBoolean(args[key], `${method}.${key}`);
  }
  // 分页范围与服务端一致；跨字段约束由原生路由统一执行。
  if (args.offset !== undefined) assertInteger(args.offset, `${method}.offset`, 0, 4000);
  if (args.limit !== undefined) assertInteger(args.limit, `${method}.limit`, 1, 1000);
  if (args.button !== undefined) assertEnum(args.button, `${method}.button`, MOUSE_BUTTONS);
  if (args.mouse_button !== undefined) assertEnum(args.mouse_button, `${method}.mouse_button`, MOUSE_BUTTONS);
  if (args.mode !== undefined) assertEnum(args.mode, `${method}.mode`, APP_STATE_MODES);
  if (args.screenshot_detail !== undefined) assertEnum(args.screenshot_detail, `${method}.screenshot_detail`, ["standard", "high"]);
  if (args.format !== undefined) assertEnum(args.format, `${method}.format`, PASTE_FORMATS);
  if (args.selection !== undefined) assertEnum(args.selection, `${method}.selection`, SELECTION_TYPES);
  if (args.selection_type !== undefined) {
    assertEnum(args.selection_type, `${method}.selection_type`, SELECTION_TYPES);
  }
  if (args.rect !== undefined) {
    assertRecord(args.rect, `${method}.rect`);
    assertExactKeys(args.rect, ["x", "y", "width", "height"], `${method}.rect`);
    for (const field of ["x", "y", "width", "height"]) {
      assertNumber(args.rect[field], `${method}.rect.${field}`);
    }
    if (args.rect.width <= 0 || args.rect.height <= 0) {
      throw failure("KIMI_CU_INVALID_ARGUMENT", `${method}.rect width and height must be positive`);
    }
  }
  for (const field of ["additional_window_ids", "additionalScreenshotWindowIDs"]) {
    if (args[field] === undefined) continue;
    if (!Array.isArray(args[field])) {
      throw failure("KIMI_CU_INVALID_ARGUMENT", `${method}.${field} must be an array`);
    }
    for (const [index, id] of args[field].entries()) {
      assertInteger(id, `${method}.${field}[${index}]`, 1, UINT32_MAX);
    }
  }
  if (args.paths !== undefined) validateDragPaths(args.paths, `${method}.paths`);
}

export function validateCodeModeRequest(request) {
  assertRecord(request, "KimiCU request");
  assertExactKeys(request, ["version", "method", "arguments"], "KimiCU request");
  if (request.version !== 1) {
    throw failure("KIMI_CU_UNSUPPORTED_VERSION", "KimiCU request version must be 1");
  }
  assertString(request.method, "KimiCU request.method");
  const schema = METHODS[request.method];
  if (!schema) {
    throw failure(
      "KIMI_CU_METHOD_NOT_ALLOWED",
      `KimiCU code-mode method is not allowed: ${request.method}`,
    );
  }
  assertRecord(request.arguments, `${request.method}.arguments`);
  assertExactKeys(request.arguments, schema.allowed, `${request.method}.arguments`);
  const canonical = translateArguments(request.method, request.arguments);
  for (const key of schema.required ?? []) {
    if (canonical[key] === undefined) {
      throw failure("KIMI_CU_MISSING_ARGUMENT", `${request.method}.${key} is required`);
    }
  }
  validateTypes(request.method, request.arguments);
  if (schema.pointOrIndex) validatePointOrIndex(request.arguments, request.method);
  if (schema.optionalPointOrIndex) {
    validatePointOrIndex(request.arguments, request.method, { optional: true });
  }
  if (schema.requiresTarget) validateTarget(request.method, request.arguments);
  if (schema.requiresScrollVector) {
    if (scrollVectorAbsent(request.arguments)) {
      throw failure(
        "KIMI_CU_MISSING_ARGUMENT",
        `${request.method} requires at least one of page, dx, or dy`,
      );
    }
  }
  return request;
}

function scrollVectorAbsent(args) {
  return args.page === undefined && args.dx === undefined && args.dy === undefined;
}

const MOUSE_BUTTON_ALIASES = Object.freeze({ l: "left", r: "right", m: "middle" });

// Map the validated compatible aliases onto the native macOS ToolRouter
// fields. Only native keys are emitted; validation above has already rejected
// everything else.
export function translateArguments(method, args) {
  const out = { ...args };
  if (isRecord(out.window)) {
    if (out.app === undefined) out.app = out.window.app;
    if (out.window_id === undefined) out.window_id = out.window.id;
    delete out.window;
  }
  for (const [canonical, alternatives] of Object.entries(ARGUMENT_ALIASES)) {
    for (const alias of alternatives) {
      if (out[canonical] === undefined && out[alias] !== undefined) out[canonical] = out[alias];
      delete out[alias];
    }
  }
  if (out.mouse_button !== undefined && MOUSE_BUTTON_ALIASES[out.mouse_button]) {
    out.mouse_button = MOUSE_BUTTON_ALIASES[out.mouse_button];
  }
  return out;
}

export function validateServiceConfig(config) {
  assertRecord(config, "KimiCU service config");
  assertExactKeys(
    config,
    ["endpoint", "minimum_runtime_version", "token", "timeout_ms", "allow_dev_runtime", "approval_token", "observation_context", "context_menu_owner"],
    "KimiCU service config",
  );
  assertString(config.endpoint, "KimiCU service config.endpoint");
  validateMinimumRuntimeVersion(config.minimum_runtime_version);
  if (config.observation_context !== undefined) {
    assertString(config.observation_context, "KimiCU service config.observation_context");
  }
  if (config.context_menu_owner !== undefined) {
    assertString(config.context_menu_owner, "KimiCU service config.context_menu_owner");
  }
  if (config.token !== undefined) {
    assertString(config.token, "KimiCU service config.token");
  }
  if (config.approval_token !== undefined) {
    assertString(config.approval_token, "KimiCU service config.approval_token");
  }
  if (config.timeout_ms !== undefined) {
    assertInteger(config.timeout_ms, "KimiCU service config.timeout_ms", 1, 600_000);
  }
  if (config.allow_dev_runtime !== undefined) {
    assertBoolean(config.allow_dev_runtime, "KimiCU service config.allow_dev_runtime");
  }
  return config;
}

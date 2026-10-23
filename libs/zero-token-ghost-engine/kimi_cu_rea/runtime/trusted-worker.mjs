import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

import {
  MESSAGE_TYPE,
  OperationTombstones,
  PROTOCOL_VERSION,
  assertAllowedNamedPipePath,
  createNativePipePolicy,
  errorPayload,
  jsonValue,
  nativePipeMessage,
  operationKey,
  protocolError,
  trustedServiceResponse,
  validateServiceId,
  validateSupervisorToTrustedMessage,
  validateTrustedToSupervisorMessage,
} from "./trusted-protocol.mjs";

export const TRUSTED_WORKER_CONFIG_ENV = "KIMI_NODE_REPL_TRUSTED_CONFIG";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function canonicalPathWithin(root, candidate, code = "TRUSTED_MODULE_OUTSIDE_ROOT") {
  const canonicalCandidate = await realpath(candidate);
  if (!isWithinRoot(root, canonicalCandidate)) {
    throw protocolError(code, `trusted module escapes configured root: ${candidate}`);
  }
  return canonicalCandidate;
}

function serviceConfigFields(config) {
  if (!isRecord(config)) {
    throw protocolError("INVALID_TRUSTED_SERVICE_CONFIG", "trusted service config must be an object");
  }
  const moduleRoot = config.module_root ?? config.moduleRoot;
  const entry = config.entry;
  if (typeof moduleRoot !== "string" || moduleRoot.length === 0) {
    throw protocolError("INVALID_TRUSTED_SERVICE_CONFIG", "module_root must be a non-empty string");
  }
  if (typeof entry !== "string" || entry.length === 0) {
    throw protocolError("INVALID_TRUSTED_SERVICE_CONFIG", "entry must be a non-empty string");
  }
  const serviceConfig = config.config ?? {};
  if (!isRecord(serviceConfig)) {
    throw protocolError("INVALID_TRUSTED_SERVICE_CONFIG", "config must be a JSON object");
  }
  return { moduleRoot, entry, serviceConfig };
}

function deepFreezeJson(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function hostTurnMetadata(requestMeta) {
  const metadata = requestMeta?.["x-codex-turn-metadata"];
  if (
    !isRecord(metadata) ||
    typeof metadata.session_id !== "string" ||
    metadata.session_id.length === 0 ||
    typeof metadata.turn_id !== "string" ||
    metadata.turn_id.length === 0
  ) {
    return null;
  }
  return { sessionId: metadata.session_id, turnId: metadata.turn_id };
}

export async function createImmutableServiceRegistry(configuredServices) {
  if (!isRecord(configuredServices)) {
    throw protocolError("INVALID_TRUSTED_SERVICE_REGISTRY", "configured_services must be an object");
  }
  const registry = new Map();
  for (const [serviceId, rawConfig] of Object.entries(configuredServices)) {
    validateServiceId(serviceId);
    const { moduleRoot, entry, serviceConfig } = serviceConfigFields(rawConfig);
    const canonicalRoot = await realpath(moduleRoot);
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      throw protocolError(
        "INVALID_TRUSTED_SERVICE_ROOT",
        `trusted service root is not a directory: ${moduleRoot}`,
      );
    }
    const candidateEntry = path.isAbsolute(entry) ? entry : path.resolve(canonicalRoot, entry);
    const canonicalEntry = await canonicalPathWithin(
      canonicalRoot,
      candidateEntry,
      "TRUSTED_SERVICE_ENTRY_OUTSIDE_ROOT",
    );
    const entryStat = await stat(canonicalEntry);
    if (!entryStat.isFile()) {
      throw protocolError(
        "INVALID_TRUSTED_SERVICE_ENTRY",
        `trusted service entry is not a file: ${entry}`,
      );
    }
    registry.set(
      serviceId,
      Object.freeze({
        id: serviceId,
        moduleRoot: canonicalRoot,
        entry: canonicalEntry,
        config: deepFreezeJson(jsonValue(serviceConfig, `trusted service ${serviceId} config`)),
      }),
    );
  }
  return registry;
}

function normalizeGeneration(value) {
  const generation = String(value ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(generation)) {
    throw protocolError("INVALID_WORKER_GENERATION", "generation must be a stable identifier");
  }
  return generation;
}

function safeBase64(value, label) {
  if (typeof value !== "string") {
    throw protocolError("INVALID_CONTENT_ITEM", `${label} must be base64 text`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw protocolError("INVALID_CONTENT_ITEM", `${label} must be canonical base64 text`);
  }
  return value;
}

function normalizeMedia(kind, input) {
  if (!isRecord(input)) {
    throw protocolError("INVALID_CONTENT_ITEM", `${kind} content must be an object`);
  }
  const mimeType = input.mime_type ?? input.mimeType;
  const dataBase64 = input.data_base64 ?? input.data;
  if (typeof mimeType !== "string" || mimeType.length === 0) {
    throw protocolError("INVALID_CONTENT_ITEM", `${kind} mime type is required`);
  }
  return {
    type: kind,
    mime_type: mimeType,
    data_base64: safeBase64(dataBase64, `${kind}.data_base64`),
  };
}

function normalizeContentItem(item) {
  if (!isRecord(item) || typeof item.type !== "string") {
    throw protocolError("INVALID_CONTENT_ITEM", "content item requires a type");
  }
  switch (item.type) {
    case "text":
      if (typeof item.text !== "string") {
        throw protocolError("INVALID_CONTENT_ITEM", "text content requires text");
      }
      return jsonValue(item, "text content item");
    case "image":
    case "audio":
      return normalizeMedia(item.type, item);
    case "resource":
      if (!isRecord(item.resource) || typeof item.resource.uri !== "string") {
        throw protocolError(
          "INVALID_CONTENT_ITEM",
          "resource content requires resource.uri",
        );
      }
      return jsonValue(item, "resource content item");
    case "resource_link":
      if (typeof item.uri !== "string" || typeof item.name !== "string") {
        throw protocolError(
          "INVALID_CONTENT_ITEM",
          "resource_link content requires uri and name",
        );
      }
      return jsonValue(item, "resource link content item");
    default:
      throw protocolError("INVALID_CONTENT_ITEM", `unsupported content item type: ${item.type}`);
  }
}

function resolveImport(specifier, parentIdentifier) {
  if (
    typeof specifier !== "string" ||
    (!specifier.startsWith("./") && !specifier.startsWith("../"))
  ) {
    throw protocolError(
      "TRUSTED_IMPORT_NOT_ALLOWED",
      `trusted services may import only relative modules: ${String(specifier)}`,
    );
  }
  return path.resolve(path.dirname(parentIdentifier), specifier);
}

class TrustedServiceLoader {
  #api;
  #diagnostic;
  #handlers = new Map();

  constructor(api, diagnostic) {
    this.#api = api;
    this.#diagnostic = diagnostic;
  }

  async load(service) {
    if (this.#handlers.has(service.id)) return this.#handlers.get(service.id);
    const loading = this.#loadUncached(service);
    this.#handlers.set(service.id, loading);
    try {
      return await loading;
    } catch (error) {
      this.#handlers.delete(service.id);
      throw error;
    }
  }

  async #loadUncached(service) {
    if (typeof vm.SourceTextModule !== "function") {
      throw protocolError(
        "TRUSTED_MODULE_LOADER_UNAVAILABLE",
        "trusted worker requires Node --experimental-vm-modules",
      );
    }
    const diagnostic = this.#diagnostic;
    const trustedConsole = Object.freeze({
      log(...values) {
        diagnostic(values.map(String).join(" "));
      },
      warn(...values) {
        diagnostic(values.map(String).join(" "));
      },
      error(...values) {
        diagnostic(values.map(String).join(" "));
      },
    });
    const context = vm.createContext({
      Buffer,
      TextDecoder,
      TextEncoder,
      clearInterval,
      clearTimeout,
      console: trustedConsole,
      nodeRepl: this.#api,
      queueMicrotask,
      setInterval,
      setTimeout,
      structuredClone,
    });
    const modules = new Map();
    let linker;

    const createModule = async (candidate) => {
      const canonical = await canonicalPathWithin(service.moduleRoot, candidate);
      if (modules.has(canonical)) return modules.get(canonical);
      const source = await readFile(canonical, "utf8");
      const module = new vm.SourceTextModule(source, {
        context,
        identifier: canonical,
        initializeImportMeta(meta) {
          meta.url = `trusted:${service.id}/${path.relative(service.moduleRoot, canonical).replaceAll("\\", "/")}`;
        },
        importModuleDynamically: async (specifier, referencingModule) => {
          const child = await createModule(resolveImport(specifier, referencingModule.identifier));
          if (child.status === "unlinked") await child.link(linker);
          if (child.status === "linked") await child.evaluate();
          return child;
        },
      });
      modules.set(canonical, module);
      return module;
    };
    linker = (specifier, referencingModule) =>
      createModule(resolveImport(specifier, referencingModule.identifier));

    const entry = await createModule(service.entry);
    await entry.link(linker);
    await entry.evaluate();
    if (typeof entry.namespace.handleRpc !== "function") {
      throw protocolError(
        "INVALID_TRUSTED_SERVICE_EXPORT",
        `trusted service ${service.id} must export handleRpc`,
      );
    }
    if (
      entry.namespace.handleExecEnd !== undefined &&
      typeof entry.namespace.handleExecEnd !== "function"
    ) {
      throw protocolError(
        "INVALID_TRUSTED_SERVICE_EXPORT",
        `trusted service ${service.id} handleExecEnd must be a function`,
      );
    }
    return Object.freeze({
      handleRpc: entry.namespace.handleRpc,
      handleExecEnd: entry.namespace.handleExecEnd,
    });
  }
}

export class TrustedWorkerRuntime {
  #generation;
  #services;
  #pipePolicy;
  #send;
  #diagnostic;
  #als = new AsyncLocalStorage();
  #loader;
  #execScopes = new Map();
  #execTombstones;
  #pending = new Map();
  #connections = new Map();
  #tombstones;
  #closedConnections;
  #nextConnectionId = 1;
  #closed = false;
  #idleWaiters = new Set();
  #serviceApi;

  static async create(options) {
    const services = await createImmutableServiceRegistry(
      options.configuredServices ?? options.configured_services,
    );
    return new TrustedWorkerRuntime({
      ...options,
      generation: normalizeGeneration(options.generation),
      services,
      pipePolicy: createNativePipePolicy(options.nativePipe ?? options.native_pipe ?? {}),
    });
  }

  constructor(options) {
    if (typeof options.send !== "function") {
      throw protocolError("INVALID_TRUSTED_WORKER_CONFIG", "send callback is required");
    }
    this.#generation = options.generation;
    this.#services = options.services;
    this.#pipePolicy = options.pipePolicy;
    this.#send = options.send;
    this.#diagnostic =
      typeof options.diagnostic === "function" ? options.diagnostic : () => {};
    this.#tombstones = new OperationTombstones(options.tombstoneLimit ?? 1_024);
    this.#execTombstones = new OperationTombstones(options.tombstoneLimit ?? 1_024);
    this.#closedConnections = new OperationTombstones(options.tombstoneLimit ?? 1_024);
    this.#serviceApi = this.#createServiceApi();
    this.#loader = new TrustedServiceLoader(this.#serviceApi, this.#diagnostic);
  }

  get generation() {
    return this.#generation;
  }

  get closed() {
    return this.#closed;
  }

  stats() {
    return Object.freeze({
      generation: this.#generation,
      pendingOperations: this.#pending.size,
      nativeConnections: this.#connections.size,
      tombstones: this.#tombstones.size,
      closed: this.#closed,
    });
  }

  readyMessage() {
    return Object.freeze({ version: PROTOCOL_VERSION, type: MESSAGE_TYPE.TRUSTED_WORKER_READY });
  }

  async accept(rawMessage) {
    let message;
    try {
      message = validateSupervisorToTrustedMessage(rawMessage);
    } catch (error) {
      if (rawMessage?.type === MESSAGE_TYPE.SERVICE) {
        this.#sendRejectedService(rawMessage, error);
        return;
      }
      throw error;
    }
    if (message.type === MESSAGE_TYPE.SHUTDOWN) {
      await this.shutdown("supervisor_shutdown");
      return;
    }
    if (this.#closed) {
      throw protocolError("TRUSTED_WORKER_CLOSED", "trusted worker generation is closed");
    }
    if (message.type === MESSAGE_TYPE.EXEC_START) {
      this.#startExec(message);
      return;
    }
    if (message.type === MESSAGE_TYPE.EXEC_END) {
      await this.#endExec(message);
      return;
    }
    if (message.type === MESSAGE_TYPE.SERVICE) {
      this.#startService(message);
      return;
    }
    this.#acceptNativePipeMessage(message);
  }

  async shutdown(reason = "worker_shutdown") {
    if (this.#closed) return;
    this.#closed = true;
    for (const execScope of [...this.#execScopes.values()]) {
      if (execScope.ending) this.#forceCloseExecScope(execScope, reason);
      else await this.#closeExecScope(execScope, reason, { runHooks: false });
    }
    this.#notifyIdle();
  }

  waitForIdle() {
    if (this.#pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  #notifyIdle() {
    if (this.#pending.size !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  #sendMessage(message) {
    validateTrustedToSupervisorMessage(message);
    this.#send(message);
  }

  #lifecycleAck(type, execId, lifecycleNonce, applied) {
    this.#sendMessage({
      version: PROTOCOL_VERSION,
      type,
      exec_id: execId,
      lifecycle_nonce: lifecycleNonce,
      applied,
    });
  }

  #startExec(message) {
    const lifecycle = jsonValue(message.lifecycle, "lifecycle");
    const nonce = lifecycle.cell.nonce;
    const key = operationKey(message.exec_id, nonce);
    const active = this.#execScopes.get(message.exec_id);
    const hostTurn = hostTurnMetadata(message.request_meta);
    const identityMatchesMetadata = hostTurn
      ? lifecycle.kind === "host_turn" &&
        lifecycle.host.session_id === hostTurn.sessionId &&
        lifecycle.host.turn_id === hostTurn.turnId
      : lifecycle.kind === "synthetic_cell";
    if (
      String(lifecycle.cell.generation) !== this.#generation ||
      !identityMatchesMetadata ||
      this.#execTombstones.has(key) ||
      (active && active.nonce !== nonce)
    ) {
      this.#lifecycleAck(
        MESSAGE_TYPE.TRUSTED_EXEC_STARTED,
        message.exec_id,
        nonce,
        false,
      );
      return;
    }
    if (!active) {
      const execScope = {
        execId: message.exec_id,
        nonce,
        lifecycle: deepFreezeJson(lifecycle),
        requestMeta: deepFreezeJson(jsonValue(message.request_meta, "request_meta")),
        operationKeys: new Set(),
        connectionIds: new Set(),
        services: new Map(),
        hookScopes: new Set(),
        ending: false,
        terminal: false,
      };
      this.#execScopes.set(message.exec_id, execScope);
    }
    this.#lifecycleAck(
      MESSAGE_TYPE.TRUSTED_EXEC_STARTED,
      message.exec_id,
      nonce,
      true,
    );
  }

  async #endExec(message) {
    const active = this.#execScopes.get(message.exec_id);
    let applied = Boolean(active && active.nonce === message.lifecycle_nonce);
    if (applied) {
      applied = await this.#closeExecScope(
        active,
        message.outcome.reason || message.outcome.status,
        { runHooks: true, outcome: deepFreezeJson(message.outcome) },
      );
    }
    if (!this.#closed) {
      this.#lifecycleAck(
        MESSAGE_TYPE.TRUSTED_EXEC_ENDED,
        message.exec_id,
        message.lifecycle_nonce,
        applied,
      );
    }
  }

  async #closeExecScope(execScope, reason, { runHooks, outcome } = {}) {
    if (execScope.terminal || execScope.ending) return false;
    execScope.ending = true;
    for (const key of [...execScope.operationKeys]) {
      const scope = this.#pending.get(key);
      if (!scope) continue;
      scope.abortController.abort(protocolError("TRUSTED_EXEC_ENDED", reason));
      this.#closeScopeConnections(scope, reason);
      scope.terminal = true;
      this.#pending.delete(key);
      this.#tombstones.add(key);
    }
    execScope.operationKeys.clear();
    let hooksSucceeded = true;
    if (runHooks) {
      for (const { service, handlers } of execScope.services.values()) {
        if (typeof handlers.handleExecEnd !== "function") continue;
        const hookScope = {
          generation: this.#generation,
          key: operationKey(execScope.execId, `lifecycle:${execScope.nonce}`),
          execId: execScope.execId,
          operationId: `lifecycle:${execScope.nonce}`,
          serviceId: service.id,
          execScope,
          lifecycle: execScope.lifecycle,
          requestMeta: execScope.requestMeta,
          serviceConfig: service.config,
          output: [],
          contentItems: [],
          responseMeta: {},
          abortController: new AbortController(),
          connectionIds: new Set(),
          terminal: false,
        };
        execScope.hookScopes.add(hookScope);
        try {
          await this.#als.run(hookScope, () =>
            handlers.handleExecEnd(outcome ?? Object.freeze({ status: reason }), this.#serviceApi),
          );
        } catch (error) {
          hooksSucceeded = false;
          this.#diagnostic(
            `trusted service ${service.id} exec-end hook failed: ${error?.message ?? String(error)}`,
          );
        } finally {
          hookScope.terminal = true;
          execScope.hookScopes.delete(hookScope);
        }
      }
    }
    if (execScope.terminal) return false;
    this.#closeExecConnections(execScope, reason);
    execScope.terminal = true;
    if (this.#execScopes.get(execScope.execId) === execScope) {
      this.#execScopes.delete(execScope.execId);
    }
    this.#execTombstones.add(operationKey(execScope.execId, execScope.nonce));
    this.#notifyIdle();
    return hooksSucceeded;
  }

  #forceCloseExecScope(execScope, reason) {
    if (execScope.terminal) return;
    for (const key of [...execScope.operationKeys]) {
      const scope = this.#pending.get(key);
      if (!scope) continue;
      scope.abortController.abort(protocolError("TRUSTED_EXEC_ENDED", reason));
      this.#closeScopeConnections(scope, reason);
      scope.terminal = true;
      this.#pending.delete(key);
      this.#tombstones.add(key);
    }
    execScope.operationKeys.clear();
    for (const scope of execScope.hookScopes) {
      scope.abortController.abort(protocolError("TRUSTED_EXEC_ENDED", reason));
    }
    this.#closeExecConnections(execScope, reason);
    execScope.terminal = true;
    if (this.#execScopes.get(execScope.execId) === execScope) {
      this.#execScopes.delete(execScope.execId);
    }
    this.#execTombstones.add(operationKey(execScope.execId, execScope.nonce));
    this.#notifyIdle();
  }

  #sendRejectedService(message, error) {
    if (
      typeof message?.exec_id !== "string" ||
      message.exec_id.length === 0 ||
      typeof message?.operation_id !== "string" ||
      message.operation_id.length === 0
    ) {
      throw error;
    }
    const key = operationKey(message.exec_id, message.operation_id);
    if (this.#pending.has(key)) {
      throw protocolError(
        "DUPLICATE_TRUSTED_OPERATION",
        `operation is already pending: ${message.operation_id}`,
      );
    }
    if (this.#tombstones.has(key)) {
      throw protocolError(
        "LATE_TRUSTED_OPERATION",
        `operation is already terminal: ${message.operation_id}`,
      );
    }
    this.#sendMessage(
      trustedServiceResponse({
        execId: message.exec_id,
        operationId: message.operation_id,
        ok: false,
        error,
      }),
    );
    this.#tombstones.add(key);
  }

  #startService(message) {
    const key = operationKey(message.exec_id, message.operation_id);
    if (this.#pending.has(key)) {
      throw protocolError(
        "DUPLICATE_TRUSTED_OPERATION",
        `operation is already pending: ${message.operation_id}`,
      );
    }
    if (this.#tombstones.has(key)) {
      throw protocolError(
        "LATE_TRUSTED_OPERATION",
        `operation is already terminal: ${message.operation_id}`,
      );
    }
    const execScope = this.#execScopes.get(message.exec_id);
    if (!execScope || execScope.terminal || execScope.ending) {
      this.#sendRejectedService(
        message,
        protocolError(
          "TRUSTED_EXEC_NOT_ACTIVE",
          `trusted operation has no active exec lifecycle: ${message.exec_id}`,
        ),
      );
      return;
    }
    // This lookup is deliberately independent from the supervisor's service check.
    const service = this.#services.get(message.service);
    if (!service) {
      this.#sendRejectedService(
        message,
        protocolError("TRUSTED_SERVICE_NOT_CONFIGURED", `trusted service is not configured: ${message.service}`),
      );
      return;
    }
    const scope = {
      generation: this.#generation,
      key,
      execId: message.exec_id,
      operationId: message.operation_id,
      serviceId: message.service,
      execScope,
      lifecycle: execScope.lifecycle,
      requestMeta: execScope.requestMeta,
      serviceConfig: service.config,
      output: [],
      contentItems: [],
      responseMeta: {},
      abortController: new AbortController(),
      connectionIds: new Set(),
      terminal: false,
    };
    this.#pending.set(key, scope);
    execScope.operationKeys.add(key);
    void this.#runService(scope, service, message.request);
  }

  async #runService(scope, service, request) {
    try {
      const value = await this.#als.run(scope, async () => {
        const handlers = await this.#loader.load(service);
        scope.execScope.services.set(service.id, { service, handlers });
        return handlers.handleRpc(jsonValue(request, "request"), this.#serviceApi);
      });
      this.#complete(scope, true, value);
    } catch (error) {
      this.#complete(scope, false, undefined, error);
    }
  }

  #complete(scope, ok, value, error) {
    if (scope.terminal) return;
    let response;
    try {
      response = trustedServiceResponse({
        execId: scope.execId,
        operationId: scope.operationId,
        ok,
        value,
        error,
        output: scope.output,
        contentItems: scope.contentItems,
        responseMeta: scope.responseMeta,
      });
    } catch (serializationError) {
      response = trustedServiceResponse({
        execId: scope.execId,
        operationId: scope.operationId,
        ok: false,
        error: serializationError,
        output: scope.output,
        contentItems: scope.contentItems,
        responseMeta: scope.responseMeta,
      });
    }
    scope.terminal = true;
    this.#closeScopeConnections(scope, "operation_complete");
    this.#pending.delete(scope.key);
    scope.execScope.operationKeys.delete(scope.key);
    this.#tombstones.add(scope.key);
    this.#sendMessage(response);
    this.#notifyIdle();
  }

  #currentScope() {
    const scope = this.#als.getStore();
    if (!scope || scope.terminal) {
      throw protocolError(
        "NO_TRUSTED_REQUEST_CONTEXT",
        "trusted service API was used outside an active request",
      );
    }
    return scope;
  }

  #createServiceApi() {
    const runtime = this;
    const nativePipe = Object.freeze({
      createConnection(pathOrOptions) {
        const pathValue =
          typeof pathOrOptions === "string" ? pathOrOptions : pathOrOptions?.path;
        return runtime.#createNativeConnection(runtime.#currentScope(), pathValue, "operation");
      },
      createExecConnection(pathOrOptions) {
        const pathValue =
          typeof pathOrOptions === "string" ? pathOrOptions : pathOrOptions?.path;
        return runtime.#createNativeConnection(runtime.#currentScope(), pathValue, "exec");
      },
    });
    return Object.freeze({
      get requestMeta() {
        return jsonValue(runtime.#currentScope().requestMeta, "request_meta");
      },
      get lifecycle() {
        return runtime.#currentScope().lifecycle;
      },
      get serviceConfig() {
        return runtime.#currentScope().serviceConfig;
      },
      get signal() {
        return runtime.#currentScope().abortController.signal;
      },
      write(...values) {
        const scope = runtime.#currentScope();
        for (const value of values) scope.output.push(jsonValue(value, "output item"));
      },
      emitImage(image) {
        runtime.#currentScope().contentItems.push(normalizeMedia("image", image));
      },
      emitAudio(audio) {
        runtime.#currentScope().contentItems.push(normalizeMedia("audio", audio));
      },
      emitContentItem(item) {
        runtime.#currentScope().contentItems.push(normalizeContentItem(item));
      },
      setResponseMeta(meta) {
        if (!isRecord(meta)) {
          throw protocolError("INVALID_RESPONSE_META", "response metadata must be an object");
        }
        Object.assign(runtime.#currentScope().responseMeta, jsonValue(meta, "response_meta"));
      },
      nativePipe,
    });
  }

  #assertConnectionOwner(record) {
    const scope = this.#currentScope();
    if (
      scope.generation !== record.generation ||
      scope.execId !== record.execId ||
      (record.lifetime === "operation"
        ? scope.operationId !== record.operationId
        : scope.execScope !== record.execScope ||
          scope.execScope.nonce !== record.lifecycleNonce)
    ) {
      throw protocolError(
        "NATIVE_PIPE_OWNER_MISMATCH",
        `connection ${record.connectionId} belongs to another trusted ${record.lifetime} scope`,
      );
    }
  }

  async #createNativeConnection(scope, requestedPath, lifetime) {
    const allowedPath = assertAllowedNamedPipePath(requestedPath, this.#pipePolicy);
    const connectionId = `g${this.#generation}-p${this.#nextConnectionId++}`;
    const operationId =
      lifetime === "exec" ? `lifecycle:${scope.execScope.nonce}` : scope.operationId;
    const record = {
      generation: this.#generation,
      execId: scope.execId,
      operationId,
      connectionId,
      lifetime,
      lifecycleNonce: scope.execScope.nonce,
      execScope: scope.execScope,
      scope,
      state: "opening",
      writeCount: 0,
      onData: null,
      onClose: null,
      onError: null,
      pendingData: [],
      openResolve: null,
      openReject: null,
    };
    const opened = new Promise((resolve, reject) => {
      record.openResolve = resolve;
      record.openReject = reject;
    });
    this.#connections.set(connectionId, record);
    const connectionOwner = lifetime === "exec" ? scope.execScope : scope;
    connectionOwner.connectionIds.add(connectionId);
    this.#sendMessage(
      nativePipeMessage(
        MESSAGE_TYPE.NATIVE_PIPE_OPEN,
        {
          execId: scope.execId,
          operationId,
          connectionId,
        },
        { path: allowedPath },
      ),
    );
    await opened;
    return this.#publicConnection(record);
  }

  #publicConnection(record) {
    const runtime = this;
    return Object.freeze({
      id: record.connectionId,
      onData(callback) {
        runtime.#assertConnectionOwner(record);
        if (typeof callback !== "function") throw new TypeError("onData callback is required");
        record.onData = callback;
        for (const data of record.pendingData.splice(0)) {
          runtime.#invokeConnectionCallback(record, callback, data);
        }
      },
      onClose(callback) {
        runtime.#assertConnectionOwner(record);
        if (typeof callback !== "function") throw new TypeError("onClose callback is required");
        record.onClose = callback;
      },
      onError(callback) {
        runtime.#assertConnectionOwner(record);
        if (typeof callback !== "function") throw new TypeError("onError callback is required");
        record.onError = callback;
      },
      write(bytes) {
        runtime.#assertConnectionOwner(record);
        if (record.state !== "open") {
          throw protocolError("NATIVE_PIPE_NOT_OPEN", `connection is not open: ${record.connectionId}`);
        }
        if (record.lifetime === "operation" && record.writeCount !== 0) {
          throw protocolError(
            "NATIVE_PIPE_CONNECTION_REUSED",
            "one-request-per-connection permits exactly one write",
          );
        }
        record.writeCount += 1;
        const data = Buffer.from(bytes);
        runtime.#sendMessage(
          nativePipeMessage(
            MESSAGE_TYPE.NATIVE_PIPE_WRITE,
            {
              execId: record.execId,
              operationId: record.operationId,
              connectionId: record.connectionId,
            },
            { data_base64: data.toString("base64") },
          ),
        );
      },
      close() {
        runtime.#assertConnectionOwner(record);
        runtime.#closeConnection(record, "service_close");
      },
    });
  }

  #findOwnedConnection(message) {
    const record = this.#connections.get(message.connection_id);
    const key = operationKey(message.exec_id, message.operation_id);
    if (!record) {
      if (this.#tombstones.has(key)) {
        throw protocolError(
          "LATE_TRUSTED_MESSAGE",
          `late native pipe message for terminal operation: ${message.operation_id}`,
        );
      }
      throw protocolError(
        "UNKNOWN_NATIVE_PIPE_CONNECTION",
        `unknown native pipe connection: ${message.connection_id}`,
      );
    }
    if (
      record.generation !== this.#generation ||
      record.execId !== message.exec_id ||
      record.operationId !== message.operation_id
    ) {
      throw protocolError(
        "NATIVE_PIPE_OWNER_MISMATCH",
        `native pipe message crossed request ownership: ${message.connection_id}`,
      );
    }
    return record;
  }

  #acceptNativePipeMessage(message) {
    const closedConnectionKey = `${operationKey(message.exec_id, message.operation_id)}\0${message.connection_id}`;
    if (
      message.type === MESSAGE_TYPE.NATIVE_PIPE_CLOSED &&
      !this.#connections.has(message.connection_id) &&
      (this.#closedConnections.has(closedConnectionKey) ||
        this.#tombstones.has(operationKey(message.exec_id, message.operation_id)))
    ) {
      // This is the supervisor acknowledgement for a close initiated while the
      // operation was completing, not reusable data for the tombstoned request.
      return;
    }
    const record = this.#findOwnedConnection(message);
    if (message.type === MESSAGE_TYPE.NATIVE_PIPE_OPENED) {
      if (record.state !== "opening") {
        throw protocolError(
          "DUPLICATE_NATIVE_PIPE_OPEN",
          `connection was already opened: ${record.connectionId}`,
        );
      }
      record.state = "open";
      this.#als.run(record.scope, () => record.openResolve());
      return;
    }
    if (message.type === MESSAGE_TYPE.NATIVE_PIPE_DATA) {
      if (record.state !== "open") {
        throw protocolError(
          "NATIVE_PIPE_NOT_OPEN",
          `received data before open: ${record.connectionId}`,
        );
      }
      const data = Buffer.from(message.data_base64, "base64");
      if (record.onData) this.#invokeConnectionCallback(record, record.onData, data);
      else record.pendingData.push(data);
      return;
    }
    if (message.type === MESSAGE_TYPE.NATIVE_PIPE_CLOSED) {
      const error =
        typeof message.error === "string"
          ? Object.assign(new Error(message.error), { code: "NATIVE_PIPE_ERROR" })
          : message.error
            ? Object.assign(new Error(message.error.message), message.error)
            : null;
      if (record.state === "opening") {
        this.#als.run(record.scope, () =>
          record.openReject(
            error ??
              protocolError(
                "NATIVE_PIPE_CLOSED",
                `connection closed before open: ${record.connectionId}`,
              ),
          ),
        );
      } else if (error && record.onError) {
        this.#invokeConnectionCallback(record, record.onError, error);
      }
      if (record.onClose) this.#invokeConnectionCallback(record, record.onClose, error);
      this.#forgetConnection(record);
    }
  }

  #invokeConnectionCallback(record, callback, value) {
    try {
      const result = this.#als.run(record.scope, () => callback(value));
      Promise.resolve(result).catch((error) => this.#complete(record.scope, false, undefined, error));
    } catch (error) {
      this.#complete(record.scope, false, undefined, error);
    }
  }

  #forgetConnection(record) {
    if (!this.#connections.delete(record.connectionId)) return;
    record.state = "closed";
    const connectionOwner = record.lifetime === "exec" ? record.execScope : record.scope;
    connectionOwner.connectionIds.delete(record.connectionId);
  }

  #closeConnection(record, _reason) {
    if (record.state === "closed") return;
    this.#sendMessage(
      nativePipeMessage(MESSAGE_TYPE.NATIVE_PIPE_CLOSE, {
        execId: record.execId,
        operationId: record.operationId,
        connectionId: record.connectionId,
      }),
    );
    this.#closedConnections.add(
      `${operationKey(record.execId, record.operationId)}\0${record.connectionId}`,
    );
    if (record.state === "opening") {
      this.#als.run(record.scope, () =>
        record.openReject(
          protocolError("NATIVE_PIPE_CLOSED", `connection closed: ${record.connectionId}`),
        ),
      );
    }
    this.#forgetConnection(record);
  }

  #closeScopeConnections(scope, reason) {
    for (const connectionId of [...scope.connectionIds]) {
      const record = this.#connections.get(connectionId);
      if (record) this.#closeConnection(record, reason);
    }
  }

  #closeExecConnections(execScope, reason) {
    for (const connectionId of [...execScope.connectionIds]) {
      const record = this.#connections.get(connectionId);
      if (record) this.#closeConnection(record, reason);
    }
  }
}

export async function createTrustedWorkerRuntime(options) {
  return TrustedWorkerRuntime.create(options);
}

export function parseTrustedWorkerConfig(environment = process.env) {
  const encoded = environment[TRUSTED_WORKER_CONFIG_ENV];
  if (!encoded) {
    throw protocolError(
      "MISSING_TRUSTED_WORKER_CONFIG",
      `${TRUSTED_WORKER_CONFIG_ENV} is required`,
    );
  }
  let config;
  try {
    config = JSON.parse(encoded);
  } catch (error) {
    throw protocolError("INVALID_TRUSTED_WORKER_CONFIG", `invalid worker config JSON: ${error.message}`);
  }
  if (!isRecord(config)) {
    throw protocolError("INVALID_TRUSTED_WORKER_CONFIG", "worker config must be an object");
  }
  return config;
}

class JsonLineWriter {
  #stream;
  #tail = Promise.resolve();

  constructor(stream) {
    this.#stream = stream;
  }

  send(message) {
    const line = `${JSON.stringify(message)}\n`;
    this.#tail = this.#tail.then(async () => {
      if (!this.#stream.write(line, "utf8")) await once(this.#stream, "drain");
    });
  }

  flush() {
    return this.#tail;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function isNativePipeMessageForExec(message, execId) {
  return (
    message !== null &&
    typeof message === "object" &&
    message.exec_id === execId &&
    [
      MESSAGE_TYPE.NATIVE_PIPE_OPENED,
      MESSAGE_TYPE.NATIVE_PIPE_DATA,
      MESSAGE_TYPE.NATIVE_PIPE_CLOSED,
    ].includes(message.type)
  );
}

class TrustedWorkerInputPump {
  #runtime;
  #queue = [];
  #drain = null;
  #transition = null;
  #fatal = null;
  #stopped = false;

  constructor(runtime) {
    this.#runtime = runtime;
  }

  async accept(message) {
    if (this.#fatal) throw this.#fatal;
    if (this.#stopped) return;
    if (this.#transition && message?.type === MESSAGE_TYPE.SHUTDOWN) {
      await this.finish("supervisor_shutdown");
      return;
    }
    if (
      this.#transition &&
      isNativePipeMessageForExec(message, this.#transition.execId)
    ) {
      await this.#runtime.accept(message);
      if (this.#fatal) throw this.#fatal;
      return;
    }

    const queuedBehindTransition = this.#transition !== null;
    const item = {
      message,
      started: deferred(),
      done: deferred(),
    };
    this.#queue.push(item);
    this.#ensureDrain();
    if (queuedBehindTransition) return;
    if (message?.type === MESSAGE_TYPE.EXEC_END) {
      await item.started.promise;
      return;
    }
    await item.done.promise;
  }

  async finish(reason) {
    if (this.#stopped) return;
    this.#stopped = true;
    const stopped = protocolError("TRUSTED_WORKER_CLOSED", reason);
    for (const item of this.#queue.splice(0)) {
      item.started.reject(stopped);
      item.done.reject(stopped);
    }
    await this.#runtime.shutdown(reason);
  }

  #ensureDrain() {
    if (this.#drain || this.#stopped) return;
    const drain = this.#drainQueue();
    this.#drain = drain;
    drain.then(
      () => {
        if (this.#drain === drain) this.#drain = null;
        if (this.#queue.length > 0) this.#ensureDrain();
      },
      (error) => {
        this.#fatal = error;
        if (this.#drain === drain) this.#drain = null;
      },
    );
  }

  async #drainQueue() {
    while (!this.#stopped && this.#queue.length > 0) {
      const item = this.#queue.shift();
      const isExecEnd = item.message?.type === MESSAGE_TYPE.EXEC_END;
      const transition = isExecEnd
        ? { execId: item.message.exec_id }
        : null;
      if (transition) this.#transition = transition;
      item.started.resolve();
      try {
        await this.#runtime.accept(item.message);
        item.done.resolve();
      } catch (error) {
        item.done.reject(error);
        throw error;
      } finally {
        if (this.#transition === transition) this.#transition = null;
      }
    }
  }
}

export async function runTrustedWorkerProcess({
  input = process.stdin,
  output = process.stdout,
  error = process.stderr,
  environment = process.env,
} = {}) {
  const config = parseTrustedWorkerConfig(environment);
  const writer = new JsonLineWriter(output);
  const runtime = await createTrustedWorkerRuntime({
    ...config,
    send: (message) => writer.send(message),
    diagnostic: (message) => error.write(`[trusted-worker] ${message}\n`, "utf8"),
  });
  writer.send(runtime.readyMessage());
  const pump = new TrustedWorkerInputPump(runtime);
  const lines = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  try {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (parseError) {
        throw protocolError("INVALID_PROTOCOL_JSON", `invalid supervisor JSON: ${parseError.message}`);
      }
      await pump.accept(message);
      if (runtime.closed) break;
    }
  } finally {
    await pump.finish("supervisor_eof");
    await writer.flush();
  }
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  runTrustedWorkerProcess().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(
        `[trusted-worker] ${JSON.stringify(errorPayload(error, "TRUSTED_WORKER_FATAL"))}\n`,
        "utf8",
      );
      process.exit(1);
    },
  );
}

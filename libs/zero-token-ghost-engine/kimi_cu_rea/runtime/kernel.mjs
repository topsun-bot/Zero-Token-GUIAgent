import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import {
  PREVIOUS_STATE_SPECIFIER,
  compileCell,
} from './cell-compiler.mjs';
import {
  KernelProtocolError,
  KernelToSupervisor,
  SupervisorToKernel,
  errorRecord,
  isRecord,
  parseProtocolLine,
  protocolMessage,
  serializeProtocolMessage,
  validateCancelMessage,
  validateExecMessage,
  validateProtocolMessage,
  validateTrustedServiceResponse,
} from './kernel-protocol.mjs';

const PUBLIC_MODULE_EXTENSIONS = new Set(['.js', '.mjs']);

class KernelExecutionError extends Error {
  constructor(message, code, { hardResetRequired = false, location } = {}) {
    super(message);
    this.name = 'KernelExecutionError';
    this.code = code;
    this.hardResetRequired = hardResetRequired;
    this.location = location;
  }
}

export class JavaScriptKernel {
  #cwd;
  #publicModuleRoots;
  #send;
  #onDiagnostic;
  #requestStorage = new AsyncLocalStorage();
  #context;
  #packageModuleCache = new Map();
  #previousBindings = new Map();
  #parseContextJson;
  #freezeContextValue;
  #createContextDeferred;
  #createContextError;
  #createContextPromiseProxy;
  #activeExec;
  #activeExecPromise;
  #poisoned = false;
  #disposed = false;
  #readySent = false;
  #timerHandles = new Map();
  #nextTimerId = 1;
  #unhandledRejectionHandler;

  constructor({
    cwd = process.cwd(),
    publicModuleRoots = [],
    send = () => undefined,
    onDiagnostic = () => undefined,
  } = {}) {
    if (typeof vm.SourceTextModule !== 'function') {
      throw new KernelExecutionError(
        'vm.SourceTextModule requires Node to start with --experimental-vm-modules',
        'SOURCE_TEXT_MODULE_UNAVAILABLE',
        { hardResetRequired: true },
      );
    }
    if (!Array.isArray(publicModuleRoots) || publicModuleRoots.some(
      (root) => typeof root !== 'string',
    )) {
      throw new TypeError('publicModuleRoots must be an array of directory paths');
    }
    if (typeof send !== 'function' || typeof onDiagnostic !== 'function') {
      throw new TypeError('send and onDiagnostic must be functions');
    }

    this.#cwd = path.resolve(cwd);
    this.#publicModuleRoots = publicModuleRoots.map((root) => canonicalExistingPath(root));
    this.#send = send;
    this.#onDiagnostic = onDiagnostic;
    this.#createContext();

    this.#unhandledRejectionHandler = (reason) => {
      const store = this.#requestStorage.getStore();
      const rejection = errorRecord(reason, 'UNHANDLED_REJECTION');
      if (store?.open) {
        store.unhandledRejections.push(rejection);
      } else {
        this.#diagnostic({
          type: 'late_unhandled_rejection',
          exec_id: store?.execId,
          error: rejection,
        });
      }
    };
    process.on('unhandledRejection', this.#unhandledRejectionHandler);
  }

  announceReady() {
    if (this.#readySent) return;
    this.#readySent = true;
    this.#emit(KernelToSupervisor.KERNEL_READY);
  }

  async handleMessage(message) {
    validateProtocolMessage(message);
    switch (message.type) {
      case SupervisorToKernel.EXEC:
        return this.#startExec(validateExecMessage(message));
      case SupervisorToKernel.CANCEL_EXEC:
        return this.#cancelExec(validateCancelMessage(message));
      case SupervisorToKernel.TRUSTED_SERVICE_RESPONSE:
        return this.#handleTrustedServiceResponse(
          validateTrustedServiceResponse(message),
        );
      case SupervisorToKernel.SHUTDOWN:
        await this.dispose();
        return undefined;
      default:
        throw new KernelProtocolError(
          `Unsupported supervisor-to-kernel message: ${message.type}`,
          'UNSUPPORTED_MESSAGE_TYPE',
        );
    }
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#activeExec?.open) {
      this.#activeExec.rejectBoundary(new KernelExecutionError(
        'Kernel is shutting down',
        'EXEC_SHUTDOWN',
        { hardResetRequired: true },
      ));
    }
    await this.#activeExecPromise?.catch(() => undefined);
    for (const { kind, handle } of this.#timerHandles.values()) {
      if (kind === 'interval') clearInterval(handle);
      else clearTimeout(handle);
    }
    this.#timerHandles.clear();
    process.off('unhandledRejection', this.#unhandledRejectionHandler);
  }

  #startExec(message) {
    if (this.#disposed) {
      return this.#emitImmediateFailure(message.exec_id, new KernelExecutionError(
        'Kernel is disposed',
        'KERNEL_DISPOSED',
        { hardResetRequired: true },
      ));
    }
    if (this.#poisoned) {
      return this.#emitImmediateFailure(message.exec_id, new KernelExecutionError(
        'Kernel generation requires supervisor hard reset',
        'KERNEL_REQUIRES_RESET',
        { hardResetRequired: true },
      ));
    }
    if (this.#activeExec?.open) {
      return this.#emitImmediateFailure(message.exec_id, new KernelExecutionError(
        `Kernel is already executing ${this.#activeExec.execId}`,
        'EXEC_BUSY',
      ));
    }

    const promise = this.#runExec(message);
    const trackedPromise = promise.finally(() => {
      if (this.#activeExecPromise === trackedPromise) this.#activeExecPromise = undefined;
    });
    this.#activeExecPromise = trackedPromise;
    return trackedPromise;
  }

  async #runExec(message) {
    const startedAt = performance.now();
    let boundaryTimer;
    let compiled;
    let resultMessage;
    let resolveBoundary;
    let rejectBoundary;
    const boundaryPromise = new Promise((resolve, reject) => {
      resolveBoundary = resolve;
      rejectBoundary = reject;
    });
    void resolveBoundary;

    const store = {
      execId: message.exec_id,
      requestMeta: this.#contextValue(message.request_meta, { freeze: true }),
      open: true,
      operations: new Map(),
      settledOperationIds: new Set(),
      nextOperationId: 1,
      nextEffectOrder: 1,
      pending: new Set(),
      pendingFailures: [],
      unhandledRejections: [],
      fragments: [],
      commitPlan: new Map(),
      partialBindings: new Map(),
      historicalConstNames: new Set(),
      warnedHistoricalConsts: new Set(),
      cellModuleCache: new Map(),
      previousStateModule: undefined,
      previousStateOwnerIdentifier: undefined,
      previousStateLinkOpen: false,
      boundaryPromise,
      rejectBoundary,
    };
    this.#activeExec = store;

    boundaryTimer = setTimeout(() => {
      rejectBoundary(new KernelExecutionError(
        `Execution exceeded ${message.timeout_ms} ms`,
        'EXEC_TIMEOUT',
        { hardResetRequired: true },
      ));
    }, message.timeout_ms);

    await this.#requestStorage.run(store, async () => {
      try {
        const cellIdentifier = pathToFileURL(
          path.join(this.#cwd, `__kimi_cell_${message.exec_id}.mjs`),
        ).href;
        compiled = compileCell(message.code, {
          previousBindings: [...this.#previousBindings.values()].map(({ name, kind }) => ({
            name,
            kind,
          })),
        });
        store.commitPlan = new Map(compiled.bindings.map(({ name, kind, previousKind }) => [
          name,
          { runtimeKind: kind, persistentKind: previousKind ?? kind },
        ]));
        store.historicalConstNames = new Set(compiled.historicalConstNames);
        store.previousStateModule = this.#makePreviousStateModule(
          compiled.inheritedBindings,
          `${cellIdentifier}#previous-state`,
        );
        store.previousStateOwnerIdentifier = cellIdentifier;
        const commitHook = hardenFunction((name, kind, value) => (
          this.#recordCellCommit(store, name, kind, value)
        ));
        const cell = this.#makeSourceModule(compiled.source, cellIdentifier, {
          commitHook,
          commitHookProperty: compiled.commitHookProperty,
        });
        store.previousStateLinkOpen = true;
        try {
          await this.#raceBoundary(store, cell.link(this.#linker));
        } finally {
          store.previousStateLinkOpen = false;
        }
        await this.#raceBoundary(
          store,
          cell.evaluate({ timeout: message.timeout_ms }),
        );
        await this.#drainTracked(store);
        await this.#raceBoundary(store, eventLoopTurn());
        await this.#raceBoundary(store, eventLoopTurn());

        if (store.unhandledRejections.length > 0) {
          const first = store.unhandledRejections[0];
          throw new KernelExecutionError(first.message, 'UNHANDLED_REJECTION');
        }
        if (store.pendingFailures.length > 0) {
          const first = store.pendingFailures[0];
          throw new KernelExecutionError(
            `${first.kind} failed: ${first.error.message}`,
            first.error.code ?? 'TRACKED_OPERATION_FAILED',
          );
        }

        this.#commitSuccessfulBindings(cell, compiled.bindings);
        const merged = mergeFragments(store.fragments);
        resultMessage = protocolMessage(KernelToSupervisor.EXEC_RESULT, {
          exec_id: message.exec_id,
          ok: true,
          // Tool-visible results are explicit side effects (write/content/meta),
          // not JavaScript module completion values. Keep the protocol field for
          // compatibility while the compiler's named snapshot exports remain
          // internal to cross-cell state persistence.
          value: null,
          ...merged,
        });
      } catch (caught) {
        await this.#evictErroredCellModules();
        const error = normalizeExecutionError(caught);
        if (error.hardResetRequired) this.#poisoned = true;
        this.#diagnostic({
          type: 'cell_execution_error',
          exec_id: message.exec_id,
          phase: compiled ? 'execution' : 'compile',
          error_code: error.code,
          ...(error.location ? { location: error.location } : {}),
          ...(error.hardResetRequired ? { hard_reset_required: true } : {}),
        });
        this.#commitFailedBindings(store);
        resultMessage = protocolMessage(KernelToSupervisor.EXEC_RESULT, {
          exec_id: message.exec_id,
          ok: false,
          error: {
            ...errorRecord(error),
            ...(error.hardResetRequired ? { hard_reset_required: true } : {}),
          },
          output: [],
          content_items: [],
          response_meta: {},
        });
      } finally {
        clearTimeout(boundaryTimer);
        this.#clearExecTimers(store.execId);
        store.open = false;
        for (const operation of store.operations.values()) {
          operation.reject(this.#contextError(
            'Cell completed before trusted service response',
            'CELL_CLOSED',
          ));
        }
        store.operations.clear();
        if (this.#activeExec === store) this.#activeExec = undefined;
      }
    });

    this.#sendMessage(resultMessage);
    this.#emit(KernelToSupervisor.SUBMITTED_CODE_COMPLETE, {
      exec_id: message.exec_id,
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
    });
    return resultMessage;
  }

  #emitImmediateFailure(execId, error) {
    const startedAt = performance.now();
    const result = protocolMessage(KernelToSupervisor.EXEC_RESULT, {
      exec_id: execId,
      ok: false,
      error: {
        ...errorRecord(error),
        ...(error.hardResetRequired ? { hard_reset_required: true } : {}),
      },
      output: [],
      content_items: [],
      response_meta: {},
    });
    this.#sendMessage(result);
    this.#emit(KernelToSupervisor.SUBMITTED_CODE_COMPLETE, {
      exec_id: execId,
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
    });
    return Promise.resolve(result);
  }

  #cancelExec(message) {
    const store = this.#activeExec;
    if (!store?.open || store.execId !== message.exec_id) {
      throw new KernelProtocolError(
        `cancel_exec does not own active exec ${message.exec_id}`,
        'UNKNOWN_EXEC',
      );
    }
    store.rejectBoundary(new KernelExecutionError(
      message.reason || 'Execution cancelled by supervisor',
      'EXEC_CANCELLED',
      { hardResetRequired: true },
    ));
  }

  #handleTrustedServiceResponse(message) {
    const store = this.#activeExec;
    if (!store?.open) {
      throw new KernelProtocolError(
        `Late trusted response for ${message.exec_id}/${message.operation_id}`,
        'LATE_OPERATION_RESPONSE',
      );
    }
    if (store.execId !== message.exec_id) {
      throw new KernelProtocolError(
        `Trusted response belongs to ${message.exec_id}, active exec is ${store.execId}`,
        'CROSS_EXEC_RESPONSE',
      );
    }
    if (store.settledOperationIds.has(message.operation_id)) {
      throw new KernelProtocolError(
        `Duplicate trusted terminal for ${message.operation_id}`,
        'DUPLICATE_OPERATION_RESPONSE',
      );
    }
    const operation = store.operations.get(message.operation_id);
    if (!operation) {
      throw new KernelProtocolError(
        `Unknown trusted operation ${message.operation_id}`,
        'UNKNOWN_OPERATION',
      );
    }

    store.operations.delete(message.operation_id);
    store.settledOperationIds.add(message.operation_id);
    store.fragments.push({
      order: operation.effectOrder,
      output: message.output ?? [],
      content_items: message.content_items ?? [],
      response_meta: message.response_meta ?? {},
    });

    if (message.ok) {
      operation.resolve(this.#contextValue(message.value));
    } else {
      operation.reject(this.#contextError(
        message.error.message,
        message.error.code ?? 'TRUSTED_SERVICE_ERROR',
      ));
    }
  }

  #createContext() {
    const sandbox = Object.create(null);
    const nodeRepl = Object.create(null);
    const requestMetaGetter = hardenFunction(
      () => this.#requestStorage.getStore()?.requestMeta,
    );
    Object.defineProperty(nodeRepl, 'requestMeta', {
      enumerable: true,
      get: requestMetaGetter,
    });
    Object.defineProperty(nodeRepl, 'rpc', {
      enumerable: true,
      value: hardenFunction((service, request) => this.#rpc(service, request)),
    });
    Object.defineProperty(nodeRepl, 'track', {
      enumerable: true,
      value: hardenFunction((promise) => this.#track(promise)),
    });
    Object.defineProperty(nodeRepl, 'write', {
      enumerable: true,
      value: hardenFunction((...values) => this.#writeValues(values)),
    });
    Object.freeze(nodeRepl);

    const consoleObject = Object.create(null);
    for (const [name, stream] of [
      ['log', 'stdout'],
      ['info', 'stdout'],
      ['debug', 'stdout'],
      ['warn', 'stderr'],
      ['error', 'stderr'],
    ]) {
      consoleObject[name] = hardenFunction((...values) => {
        this.#writeConsole(stream, values);
      });
    }
    Object.freeze(consoleObject);

    const kernelGlobals = {
      nodeRepl,
      console: consoleObject,
      setTimeout: hardenFunction((callback, delay, ...args) => (
        this.#scheduleTimer('timeout', callback, delay, args)
      )),
      clearTimeout: hardenFunction((timerId) => this.#clearTimer(timerId)),
      setInterval: hardenFunction((callback, delay, ...args) => (
        this.#scheduleTimer('interval', callback, delay, args)
      )),
      clearInterval: hardenFunction((timerId) => this.#clearTimer(timerId)),
      queueMicrotask: hardenFunction((callback) => {
        if (typeof callback !== 'function') {
          throw new TypeError('queueMicrotask callback must be a function');
        }
        queueMicrotask(() => this.#invokeUserCallback(callback, [], 'microtask callback'));
      }),
    };
    for (const [name, value] of Object.entries(kernelGlobals)) {
      Object.defineProperty(sandbox, name, {
        value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }

    this.#context = vm.createContext(sandbox, {
      name: 'kimi-cu-clean-room-kernel',
      codeGeneration: { strings: false, wasm: false },
    });
    this.#parseContextJson = vm.runInContext('(json) => JSON.parse(json)', this.#context);
    this.#freezeContextValue = vm.runInContext(`
      (value) => {
        const seen = new WeakSet();
        const freeze = (item) => {
          if (item === null || typeof item !== 'object' || seen.has(item)) return item;
          seen.add(item);
          for (const key of Object.keys(item)) freeze(item[key]);
          return Object.freeze(item);
        };
        return freeze(value);
      }
    `, this.#context);
    this.#createContextDeferred = vm.runInContext(`
      () => {
        let resolve;
        let reject;
        const promise = new Promise((onResolve, onReject) => {
          resolve = onResolve;
          reject = onReject;
        });
        return { promise, resolve, reject };
      }
    `, this.#context);
    this.#createContextError = vm.runInContext(`
      (message, code) => Object.assign(new Error(message), { code })
    `, this.#context);
    this.#createContextPromiseProxy = vm.runInContext(`
      (promise) => promise.then(
        (value) => value,
        (error) => { throw error; }
      )
    `, this.#context);
  }

  #rpc(service, request) {
    const store = this.#requestStorage.getStore();
    const deferred = this.#createContextDeferred();
    if (!store?.open) {
      deferred.reject(this.#contextError(
        'nodeRepl.rpc() is only available during an open cell',
        'CELL_CLOSED',
      ));
      return deferred.promise;
    }
    if (typeof service !== 'string' || service.length === 0 || !isRecord(request)) {
      deferred.reject(this.#contextError(
        'nodeRepl.rpc(service, request) requires a service name and request object',
        'INVALID_RPC_REQUEST',
      ));
      return this.#trackRpcPromise(store, deferred.promise);
    }

    let protocolRequest;
    try {
      protocolRequest = jsonProtocolValue(request, 'trusted service request');
    } catch (error) {
      deferred.reject(this.#contextError(error.message, error.code));
      return this.#trackRpcPromise(store, deferred.promise);
    }

    const operationId = `o${store.nextOperationId++}`;
    const effectOrder = store.nextEffectOrder++;
    store.operations.set(operationId, {
      resolve: deferred.resolve,
      reject: deferred.reject,
      effectOrder,
    });
    try {
      this.#emit(KernelToSupervisor.TRUSTED_SERVICE_REQUEST, {
        exec_id: store.execId,
        operation_id: operationId,
        service,
        request: protocolRequest,
      });
    } catch (error) {
      store.operations.delete(operationId);
      deferred.reject(this.#contextError(error.message, error.code));
    }
    return this.#trackRpcPromise(store, deferred.promise);
  }

  #track(promise) {
    const store = this.#requestStorage.getStore();
    if (!store?.open) {
      throw this.#contextError(
        'nodeRepl.track() is only available during an open cell',
        'CELL_CLOSED',
      );
    }
    if (!promise || typeof promise.then !== 'function') {
      throw this.#contextError(
        'nodeRepl.track() requires a Promise or thenable',
        'INVALID_TRACKED_PROMISE',
      );
    }
    return this.#trackBackgroundPromise(store, promise, 'background task');
  }

  #trackRpcPromise(store, promise) {
    const observed = promise.then(
      () => undefined,
      () => undefined,
    );
    store.pending.add(observed);
    observed.finally(() => store.pending.delete(observed));
    return this.#createContextPromiseProxy(promise);
  }

  #trackBackgroundPromise(store, promise, kind) {
    store.pending.add(promise);
    promise.then(
      () => store.pending.delete(promise),
      (error) => {
        store.pending.delete(promise);
        store.pendingFailures.push({ kind, error: errorRecord(error) });
      },
    );
    return promise;
  }

  async #drainTracked(store) {
    while (store.pending.size > 0) {
      await this.#raceBoundary(store, Promise.allSettled([...store.pending]));
      await this.#raceBoundary(store, eventLoopTurn());
    }
  }

  #raceBoundary(store, promise) {
    return Promise.race([promise, store.boundaryPromise]);
  }

  #writeConsole(stream, values) {
    const store = this.#requestStorage.getStore();
    const text = values.map(formatConsoleValue).join(' ');
    if (store?.open) {
      store.fragments.push({
        order: store.nextEffectOrder++,
        output: [{ type: 'console', stream, text }],
        content_items: [],
        response_meta: {},
      });
    } else {
      this.#diagnostic({
        type: 'late_console',
        exec_id: store?.execId,
        stream,
        text,
      });
    }
  }

  #writeValues(values) {
    const store = this.#requestStorage.getStore();
    if (!store?.open) {
      throw this.#contextError(
        'nodeRepl.write() is only available during an open cell',
        'CELL_CLOSED',
      );
    }
    const output = values.map((value) => jsonProtocolValue(value, 'nodeRepl.write output'));
    store.fragments.push({
      order: store.nextEffectOrder++,
      output,
      content_items: [],
      response_meta: {},
    });
  }

  #scheduleTimer(kind, callback, delay, args) {
    if (typeof callback !== 'function') {
      throw new TypeError('Timer callback must be a function');
    }
    const timerId = this.#nextTimerId++;
    const store = this.#requestStorage.getStore();
    const milliseconds = normalizeTimerDelay(delay);
    const invoke = () => {
      if (kind === 'timeout') this.#timerHandles.delete(timerId);
      this.#invokeUserCallback(callback, args, `${kind} callback`);
    };
    const handle = kind === 'interval'
      ? setInterval(invoke, milliseconds)
      : setTimeout(invoke, milliseconds);
    this.#timerHandles.set(timerId, { kind, handle, execId: store?.execId });
    return timerId;
  }

  #clearTimer(timerId) {
    const timer = this.#timerHandles.get(timerId);
    if (!timer) return;
    this.#timerHandles.delete(timerId);
    if (timer.kind === 'interval') clearInterval(timer.handle);
    else clearTimeout(timer.handle);
  }

  #clearExecTimers(execId) {
    for (const [timerId, timer] of this.#timerHandles) {
      if (timer.execId === execId) this.#clearTimer(timerId);
    }
  }

  async #evictErroredCellModules() {
    const cache = this.#requestStorage.getStore()?.cellModuleCache;
    if (!cache) return;
    for (const [moduleUrl, loading] of cache) {
      try {
        const module = await loading;
        if (module.status === 'errored') cache.delete(moduleUrl);
      } catch {
        cache.delete(moduleUrl);
      }
    }
  }

  #invokeUserCallback(callback, args, kind) {
    try {
      return callback(...args);
    } catch (error) {
      const store = this.#requestStorage.getStore();
      if (store?.open) {
        store.pendingFailures.push({ kind, error: errorRecord(error) });
      } else {
        this.#diagnostic({
          type: 'late_uncaught_exception',
          exec_id: store?.execId,
          error: errorRecord(error),
        });
      }
      return undefined;
    }
  }

  #makeSourceModule(source, identifier, {
    commitHook,
    commitHookProperty,
  } = {}) {
    return new vm.SourceTextModule(source, {
      context: this.#context,
      identifier,
      initializeImportMeta(meta, module) {
        meta.url = module.identifier;
        if (commitHookProperty !== undefined) {
          Object.defineProperty(meta, commitHookProperty, {
            value: commitHook,
            enumerable: false,
            configurable: true,
            writable: false,
          });
        }
      },
      importModuleDynamically: async (specifier, referencingModule) => {
        const imported = await this.#linker(specifier, referencingModule);
        if (imported.status === 'unlinked') await imported.link(this.#linker);
        if (imported.status === 'linked') await imported.evaluate();
        return imported;
      },
    });
  }

  #makePreviousStateModule(bindings, identifier) {
    const exportNames = bindings.map(({ name }) => name);
    const previousBindings = this.#previousBindings;
    return new vm.SyntheticModule(exportNames, function initializePreviousState() {
      for (const name of exportNames) {
        this.setExport(name, previousBindings.get(name).value);
      }
    }, {
      context: this.#context,
      identifier,
    });
  }

  #commitSuccessfulBindings(cell, bindings) {
    const nextBindings = new Map();
    for (const {
      name,
      kind,
      previousKind,
      exportName,
    } of bindings) {
      nextBindings.set(name, {
        name,
        kind: previousKind ?? kind,
        value: cell.namespace[exportName],
      });
    }
    this.#previousBindings = nextBindings;
  }

  #recordCellCommit(store, name, kind, value) {
    if (!store.open || this.#activeExec !== store) {
      // A persisted function keeps its original lexical environment. When a
      // later cell invokes it, mutations belong to that private environment;
      // they must not overwrite the current top-level snapshot or fail merely
      // because the defining cell has completed.
      return value;
    }
    const plan = store.commitPlan.get(name);
    if (plan?.runtimeKind !== kind) {
      throw this.#contextError(
        `Binding commit is not in the compiled plan: ${String(name)}`,
        'INVALID_BINDING_COMMIT',
      );
    }
    if (
      store.historicalConstNames.has(name)
      && !store.warnedHistoricalConsts.has(name)
    ) {
      store.warnedHistoricalConsts.add(name);
      store.fragments.push({
        order: store.nextEffectOrder++,
        output: [{
          type: 'warning',
          code: 'HISTORICAL_CONST_DOWNGRADED',
          binding: name,
          message: `${name} was declared with const; use let for reassignable variables.`,
        }],
        content_items: [],
        response_meta: {},
      });
    }
    store.partialBindings.set(name, { name, kind: plan.persistentKind, value });
    return value;
  }

  #commitFailedBindings(store) {
    if (store.partialBindings.size === 0) return;
    const nextBindings = new Map(this.#previousBindings);
    for (const [name, binding] of store.partialBindings) nextBindings.set(name, binding);
    this.#previousBindings = nextBindings;
  }

  #linker = async (specifier, referencingModule) => {
    const store = this.#requestStorage.getStore();
    if (specifier === PREVIOUS_STATE_SPECIFIER) {
      if (
        !store?.previousStateModule
        || !store.previousStateLinkOpen
        || referencingModule.identifier !== store.previousStateOwnerIdentifier
      ) {
        throw this.#contextError(
          `Unsupported import specifier ${JSON.stringify(specifier)} in node_repl. Use a package name like "lodash" or "@scope/pkg", or a relative/absolute/file:// .js/.mjs path.`,
          'MODULE_NOT_ALLOWED',
        );
      }
      return store.previousStateModule;
    }
    const moduleUrl = await this.#resolvePublicModule(specifier, referencingModule.identifier);
    const cache = isPackageModuleUrl(moduleUrl)
      ? this.#packageModuleCache
      : store?.cellModuleCache;
    if (!cache) {
      throw this.#contextError(
        'Local module imports require an active cell',
        'CELL_CLOSED',
      );
    }
    if (cache.has(moduleUrl)) return cache.get(moduleUrl);

    const loading = (async () => {
      const source = await readFile(fileURLToPath(moduleUrl), 'utf8');
      return this.#makeSourceModule(source, moduleUrl);
    })();
    cache.set(moduleUrl, loading);
    try {
      return await loading;
    } catch (error) {
      cache.delete(moduleUrl);
      throw error;
    }
  };

  async #resolvePublicModule(specifier, parentIdentifier) {
    if (typeof specifier !== 'string' || specifier.length === 0) {
      throw new KernelExecutionError('Import specifier must be a string', 'MODULE_NOT_ALLOWED');
    }
    if (specifier.startsWith('node:') || isBuiltin(specifier)) {
      throw this.#contextError(
        `Node builtin imports are disabled in the kernel: ${specifier}`,
        'MODULE_NOT_ALLOWED',
      );
    }
    if (this.#publicModuleRoots.length === 0) {
      throw this.#contextError(
        `No public module roots are configured; import denied: ${specifier}`,
        'MODULE_NOT_ALLOWED',
      );
    }

    let candidate;
    if (
      specifier.startsWith('.') ||
      specifier.startsWith('/') ||
      specifier.startsWith('file:') ||
      /^[A-Za-z]:[\\/]/.test(specifier)
    ) {
      if (/^[A-Za-z]:[\\/]/.test(specifier)) {
        candidate = specifier;
      } else if (specifier.startsWith('file:')) {
        candidate = fileURLToPath(specifier);
      } else {
        candidate = fileURLToPath(new URL(specifier, parentIdentifier));
      }
      return this.#validatedModuleUrl(candidate, specifier);
    }

    for (const root of this.#publicModuleRoots) {
      try {
        const resolved = createRequire(path.join(root, '__kernel_resolver__.mjs')).resolve(specifier);
        return await this.#validatedModuleUrl(resolved, specifier);
      } catch {
        // A public root may be a package search root rather than node_modules.
      }
      for (const candidate of [
        path.join(root, specifier),
        path.join(root, `${specifier}.mjs`),
        path.join(root, `${specifier}.js`),
        path.join(root, specifier, 'index.mjs'),
        path.join(root, specifier, 'index.js'),
      ]) {
        try {
          return await this.#validatedModuleUrl(candidate, specifier);
        } catch {
          // Try the next canonical candidate, then deny the import below.
        }
      }
    }
    throw this.#contextError(
      `Public module could not be resolved: ${specifier}`,
      'MODULE_NOT_ALLOWED',
    );
  }

  async #validatedModuleUrl(candidate, specifier) {
    let canonical;
    try {
      canonical = await realpath(path.resolve(candidate));
    } catch {
      throw this.#contextError(
        `Public module does not exist: ${specifier}`,
        'MODULE_NOT_ALLOWED',
      );
    }
    if (!this.#publicModuleRoots.some((root) => pathIsWithin(root, canonical))) {
      throw this.#contextError(
        `Import resolves outside configured public module roots: ${specifier}`,
        'MODULE_NOT_ALLOWED',
      );
    }
    if (!PUBLIC_MODULE_EXTENSIONS.has(path.extname(canonical).toLowerCase())) {
      throw this.#contextError(
        `Only public .js and .mjs modules are supported: ${specifier}`,
        'MODULE_NOT_ALLOWED',
      );
    }
    return pathToFileURL(canonical).href;
  }

  #contextValue(value, { freeze = false } = {}) {
    const serialized = JSON.stringify(value ?? null);
    const parsed = this.#parseContextJson(serialized);
    return freeze ? this.#freezeContextValue(parsed) : parsed;
  }

  #contextError(message, code) {
    return this.#createContextError(String(message), code ?? 'EXEC_ERROR');
  }

  #emit(type, fields = {}) {
    this.#sendMessage(protocolMessage(type, fields));
  }

  #sendMessage(message) {
    const serialized = serializeProtocolMessage(message);
    this.#send(JSON.parse(serialized));
  }

  #diagnostic(diagnostic) {
    try {
      this.#onDiagnostic(diagnostic);
    } catch {
      // Diagnostics must never break protocol processing.
    }
  }
}

export async function runKernelStdio({
  cwd = process.env.KIMI_NODE_REPL_CWD || process.cwd(),
  publicModuleRoots = readPublicModuleRootsFromEnvironment(),
  input = process.stdin,
  output = process.stdout,
  diagnosticOutput = process.stderr,
} = {}) {
  const kernel = new JavaScriptKernel({
    cwd,
    publicModuleRoots,
    send(message) {
      output.write(`${serializeProtocolMessage(message)}\n`);
    },
    onDiagnostic(diagnostic) {
      diagnosticOutput.write(`${JSON.stringify({ source: 'kernel', ...diagnostic })}\n`);
    },
  });
  kernel.announceReady();

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  await new Promise((resolve) => {
    let closing = false;
    lines.on('line', (line) => {
      if (line.trim().length === 0 || closing) return;
      let message;
      try {
        message = parseProtocolLine(line);
      } catch (error) {
        diagnosticOutput.write(`${JSON.stringify({
          source: 'kernel',
          type: 'protocol_error',
          error: errorRecord(error),
        })}\n`);
        return;
      }

      if (message.type === SupervisorToKernel.SHUTDOWN) {
        closing = true;
        void kernel.handleMessage(message).finally(() => lines.close());
        return;
      }
      void kernel.handleMessage(message).catch((error) => {
        diagnosticOutput.write(`${JSON.stringify({
          source: 'kernel',
          type: 'protocol_error',
          error: errorRecord(error),
        })}\n`);
      });
    });
    lines.once('close', resolve);
  });
  await kernel.dispose();
}

function normalizeExecutionError(error) {
  if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
    return new KernelExecutionError(
      error.message,
      'EXEC_TIMEOUT',
      { hardResetRequired: true },
    );
  }
  if (error instanceof KernelExecutionError) return error;
  return new KernelExecutionError(
    error?.message ?? String(error),
    error?.code ?? 'EXEC_ERROR',
    { location: error?.location },
  );
}

function mergeFragments(fragments) {
  const output = [];
  const content_items = [];
  const response_meta = {};
  for (const fragment of [...fragments].sort((left, right) => left.order - right.order)) {
    output.push(...fragment.output);
    content_items.push(...fragment.content_items);
    Object.assign(response_meta, fragment.response_meta);
  }
  return { output, content_items, response_meta };
}

function jsonProtocolValue(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new KernelExecutionError(
      `${label} is not JSON serializable: ${error.message}`,
      'UNSERIALIZABLE_VALUE',
    );
  }
  if (serialized === undefined) {
    throw new KernelExecutionError(
      `${label} is not JSON serializable`,
      'UNSERIALIZABLE_VALUE',
    );
  }
  return JSON.parse(serialized);
}

function canonicalExistingPath(value) {
  return realpathSync.native(path.resolve(value));
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isPackageModuleUrl(moduleUrl) {
  const segments = fileURLToPath(moduleUrl).split(/[\\/]+/);
  return segments.some((segment) => segment.toLowerCase() === 'node_modules');
}

function hardenFunction(fn) {
  Object.setPrototypeOf(fn, null);
  return Object.freeze(fn);
}

function formatConsoleValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return String(value);
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return '[Unserializable value]';
  }
}

function normalizeTimerDelay(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(number, 2_147_483_647);
}

function eventLoopTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function readPublicModuleRootsFromEnvironment() {
  const raw = process.env.KIMI_NODE_REPL_PUBLIC_MODULE_ROOTS;
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`KIMI_NODE_REPL_PUBLIC_MODULE_ROOTS is invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((root) => typeof root !== 'string')) {
    throw new Error('KIMI_NODE_REPL_PUBLIC_MODULE_ROOTS must be a JSON string array');
  }
  return parsed;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  await runKernelStdio().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      source: 'kernel',
      type: 'fatal_error',
      error: errorRecord(error),
    })}\n`);
    process.exitCode = 1;
  });
}

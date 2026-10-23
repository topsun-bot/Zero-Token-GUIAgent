import { parseModule } from 'meriyah';

export const PREVIOUS_STATE_SPECIFIER = 'kimi-internal:previous-state';

export class CellCompileError extends SyntaxError {
  constructor(message, code, location) {
    super(message);
    this.name = 'CellCompileError';
    this.code = code;
    this.location = location;
  }
}

const BINDING_KINDS = new Set([
  'class',
  'const',
  'function',
  'import',
  'let',
  'var',
]);

export class SourceEditor {
  #source;
  #edits = [];
  #nextOrder = 0;

  constructor(source) {
    if (typeof source !== 'string') throw new TypeError('source must be a string');
    this.#source = source;
  }

  insert(offset, text) {
    return this.replace(offset, offset, text);
  }

  replace(start, end, text) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new TypeError('edit offsets must be safe integers');
    }
    if (start < 0 || end < start || end > this.#source.length) {
      throw new RangeError(`edit range ${start}..${end} is outside source`);
    }
    if (typeof text !== 'string') throw new TypeError('replacement text must be a string');
    this.#edits.push({ start, end, text, order: this.#nextOrder++ });
    return this;
  }

  apply() {
    const sorted = [...this.#edits].sort((left, right) => (
      left.start - right.start
      || left.end - right.end
      || left.order - right.order
    ));
    let cursor = 0;
    let output = '';
    for (const edit of sorted) {
      if (edit.start < cursor) {
        throw new RangeError(
          `overlapping source edits at ${edit.start}..${edit.end}; previous edit ended at ${cursor}`,
        );
      }
      output += this.#source.slice(cursor, edit.start);
      output += edit.text;
      cursor = edit.end;
    }
    return output + this.#source.slice(cursor);
  }
}

export function compileCell(source, { previousBindings = [] } = {}) {
  if (typeof source !== 'string') throw new TypeError('cell source must be a string');
  const normalizedPrevious = normalizePreviousBindings(previousBindings);
  const ast = parseCellModule(source, 'source');
  rejectUserStaticImports(ast);
  const currentBindings = collectTopLevelBindings(ast);
  const currentNames = new Set(currentBindings.map(({ name }) => name));
  const inheritedBindings = normalizedPrevious
    .filter(({ name }) => !currentNames.has(name))
    .map((binding) => ({ ...binding, previousKind: binding.kind, kind: 'let' }));
  const persistedBindings = mergeBindings(inheritedBindings, currentBindings);
  const reservedNames = new Set([
    ...normalizedPrevious.map(({ name }) => name),
    ...currentBindings.map(({ name }) => name),
  ]);
  const internalPrefix = uniqueInternalPrefix(source, reservedNames);
  const commitIdentifier = `${internalPrefix}commit`;
  const commitHookProperty = `${internalPrefix}commit_hook`;
  const editor = new SourceEditor(source);

  const snapshotBindings = persistedBindings.map((binding, index) => ({
    ...binding,
    exportName: `${internalPrefix}binding_${index}`,
  }));
  const prelude = [];
  if (inheritedBindings.length > 0) {
    const imports = [];
    const declarations = [];
    for (const [index, { name }] of inheritedBindings.entries()) {
      const alias = `${internalPrefix}prev_${index}`;
      imports.push(`${name} as ${alias}`);
      declarations.push(`${name} = ${alias}`);
    }
    prelude.push(
      `import { ${imports.join(', ')} } from ${JSON.stringify(PREVIOUS_STATE_SPECIFIER)};`,
    );
    prelude.push(`let ${declarations.join(', ')};`);
  }
  if (snapshotBindings.length > 0) {
    prelude.push(
      `const ${commitIdentifier} = import.meta[${JSON.stringify(commitHookProperty)}];`,
      `delete import.meta[${JSON.stringify(commitHookProperty)}];`,
    );
    for (const { name, kind } of currentBindings) {
      if (kind === 'import') prelude.push(commitStatement(commitIdentifier, name, kind));
    }
  }
  if (prelude.length > 0) editor.insert(0, `${prelude.join('\n')}\n`);

  const bindingKinds = new Map(snapshotBindings.map(({ name, kind }) => [name, kind]));
  const writeWrappers = collectBindingWriteWrappers(
    ast,
    bindingKinds,
    commitIdentifier,
    internalPrefix,
  );
  instrumentDeclarations({
    ast,
    source,
    editor,
    bindingKinds,
    commitIdentifier,
    writeWrappers,
  });
  instrumentTopLevelLoops({
    ast,
    editor,
    bindingKinds,
    commitIdentifier,
  });
  for (const wrapper of writeWrappers) {
    if (wrapper.claimed) continue;
    applySourceEdit(editor, wrapper);
  }

  if (snapshotBindings.length > 0) {
    editor.insert(source.length, [
      '',
      `export { ${snapshotBindings.map(({ name, exportName }) => (
        `${name} as ${exportName}`
      )).join(', ')} };`,
    ].join('\n'));
  }

  const compiledSource = editor.apply();
  // No source map is emitted in this phase: compiled source never crosses the
  // Kernel boundary, and diagnostics expose only a phase/code/location tuple.
  // A future map must omit `sourcesContent` and carry generated-to-original
  // positions only, so neither protocol errors nor logs can reproduce user code.
  parseCellModule(compiledSource, 'instrumentation');
  return {
    source: compiledSource,
    bindings: snapshotBindings,
    commitHookProperty: snapshotBindings.length > 0 ? commitHookProperty : undefined,
    historicalConstNames: normalizedPrevious
      .filter(({ kind }) => kind === 'const')
      .map(({ name }) => name),
    inheritedBindings,
    currentBindings,
  };
}

function rejectUserStaticImports(ast) {
  for (const item of ast.body) {
    const staticSource = item.type === 'ImportDeclaration'
      ? item.source
      : (item.type === 'ExportAllDeclaration' || item.type === 'ExportNamedDeclaration')
        ? item.source
        : undefined;
    if (!staticSource) continue;
    const specifier = typeof staticSource.value === 'string'
      ? staticSource.value
      : '<unknown>';
    throw new CellCompileError(
      `Top-level static import ${JSON.stringify(specifier)} is not supported in node_repl. Use await import(${JSON.stringify(specifier)}) instead.`,
      'STATIC_IMPORT_UNSUPPORTED',
    );
  }
}

function parseCellModule(source, phase) {
  try {
    return parseModule(source, {
      next: true,
      ranges: true,
      webcompat: false,
    });
  } catch (error) {
    const location = error?.loc?.start && Number.isInteger(error.loc.start.line)
      ? { line: error.loc.start.line, column: error.loc.start.column }
      : undefined;
    const label = phase === 'source' ? 'JavaScript syntax is invalid' : 'Cell instrumentation failed';
    const suffix = location ? ` at ${location.line}:${location.column}` : '';
    throw new CellCompileError(
      `${label}${suffix}`,
      phase === 'source' ? 'CELL_SYNTAX_ERROR' : 'CELL_INSTRUMENTATION_ERROR',
      location,
    );
  }
}

export function collectTopLevelBindings(ast) {
  if (!ast || ast.type !== 'Program' || !Array.isArray(ast.body)) {
    throw new TypeError('collectTopLevelBindings requires a Meriyah Program');
  }
  const bindings = [];
  const names = new Set();
  const add = (name, kind) => {
    if (typeof name !== 'string' || !BINDING_KINDS.has(kind) || names.has(name)) return;
    names.add(name);
    bindings.push({ name, kind });
  };

  for (const item of ast.body) collectModuleItemBindings(item, add);
  return bindings;
}

function collectModuleItemBindings(item, add) {
  if (!item) return;
  if (item.type === 'ExportNamedDeclaration' || item.type === 'ExportDefaultDeclaration') {
    if (item.declaration) collectModuleItemBindings(item.declaration, add);
    return;
  }
  if (item.type === 'VariableDeclaration') {
    for (const declarator of item.declarations) {
      for (const name of bindingNames(declarator.id)) add(name, item.kind);
    }
    return;
  }
  if (item.type === 'FunctionDeclaration' && item.id) {
    add(item.id.name, 'function');
    return;
  }
  if (item.type === 'ClassDeclaration' && item.id) {
    add(item.id.name, 'class');
    return;
  }
  if (item.type === 'ImportDeclaration') {
    for (const specifier of item.specifiers) add(specifier.local.name, 'import');
    return;
  }
  if (item.type === 'ForStatement' && item.init?.type === 'VariableDeclaration') {
    collectTopLevelLoopVarBindings(item.init, add);
    return;
  }
  if (
    (item.type === 'ForInStatement' || item.type === 'ForOfStatement')
    && item.left?.type === 'VariableDeclaration'
  ) {
    collectTopLevelLoopVarBindings(item.left, add);
  }
}

function bindingNames(pattern, output = []) {
  if (!pattern) return output;
  switch (pattern.type) {
    case 'Identifier':
      output.push(pattern.name);
      break;
    case 'AssignmentPattern':
      bindingNames(pattern.left, output);
      break;
    case 'RestElement':
      bindingNames(pattern.argument, output);
      break;
    case 'ArrayPattern':
      for (const element of pattern.elements) bindingNames(element, output);
      break;
    case 'ObjectPattern':
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') bindingNames(property.argument, output);
        else bindingNames(property.value, output);
      }
      break;
    default:
      throw new TypeError(`Unsupported binding pattern: ${pattern.type}`);
  }
  return output;
}

function normalizePreviousBindings(bindings) {
  if (!Array.isArray(bindings)) throw new TypeError('previousBindings must be an array');
  const names = new Set();
  return bindings.map((binding) => {
    if (
      !binding
      || typeof binding.name !== 'string'
      || !BINDING_KINDS.has(binding.kind)
      || names.has(binding.name)
    ) {
      throw new TypeError('previousBindings must contain unique { name, kind } records');
    }
    names.add(binding.name);
    return { name: binding.name, kind: binding.kind };
  });
}

function mergeBindings(inherited, current) {
  const byName = new Map();
  for (const binding of inherited) byName.set(binding.name, binding);
  for (const binding of current) byName.set(binding.name, binding);
  return [...byName.values()];
}

function uniqueInternalPrefix(source, reservedNames) {
  for (let index = 0; ; index += 1) {
    const prefix = `__kimi_cell_${index}_`;
    if (
      !source.includes(prefix)
      && ![...reservedNames].some((name) => name.startsWith(prefix))
    ) {
      return prefix;
    }
  }
}

function instrumentDeclarations({
  ast,
  source,
  editor,
  bindingKinds,
  commitIdentifier,
  writeWrappers,
}) {
  for (const item of ast.body) {
    const declaration = item.type === 'ExportNamedDeclaration'
      || item.type === 'ExportDefaultDeclaration'
      ? item.declaration
      : item;
    if (!declaration) continue;

    if (declaration.type === 'VariableDeclaration') {
      const exported = item.type === 'ExportNamedDeclaration';
      const replacementStart = exported ? item.start : declaration.start;
      const replacementEnd = exported ? item.end : declaration.end;
      const containedWrappers = writeWrappers.filter((wrapper) => (
        wrapper.start >= replacementStart && wrapper.end <= replacementEnd
      ));
      for (const wrapper of containedWrappers) wrapper.claimed = true;
      const statements = declaration.declarations.map((declarator) => {
        const declaratorSource = renderSourceRange(
          source,
          declarator.start,
          declarator.end,
          containedWrappers,
        );
        const declarationSource = `${exported ? 'export ' : ''}${declaration.kind} ${declaratorSource};`;
        const markers = bindingNames(declarator.id).map((name) => (
          commitStatement(commitIdentifier, name, bindingKinds.get(name))
        ));
        return [declarationSource, ...markers].join('\n');
      });
      editor.replace(replacementStart, replacementEnd, statements.join('\n'));
      continue;
    }

    if (
      (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration')
      && declaration.id
    ) {
      const kind = declaration.type === 'FunctionDeclaration' ? 'function' : 'class';
      editor.insert(
        declaration.end,
        `\n${commitStatement(commitIdentifier, declaration.id.name, kind)}`,
      );
    }
  }
}

function collectBindingWriteWrappers(
  ast,
  bindingKinds,
  commitIdentifier,
  internalPrefix,
) {
  const wrappers = [];
  const persistentNames = new Set(bindingKinds.keys());
  let nextTemporary = 0;
  visitNode(ast, new Set(), {
    onAssignment(node, shadowedNames) {
      const targets = assignmentTargetRecords(node.left)
        .filter(({ name }) => persistentNames.has(name) && !shadowedNames.has(name));
      if (targets.length === 0) return;
      if (node.left.type === 'Identifier') {
        const name = node.left.name;
        wrappers.push(valueCommitWrapper(
          node,
          commitIdentifier,
          name,
          bindingKinds.get(name),
        ));
        return;
      }
      const temporary = `${internalPrefix}result_${nextTemporary++}`;
      const proxies = targets.map((target) => ({
        ...target,
        proxy: `${internalPrefix}target_${nextTemporary++}`,
        assigned: `${internalPrefix}assigned_${nextTemporary++}`,
      }));
      wrappers.push(destructuringCommitWrapper({
        node,
        temporary,
        commitIdentifier,
        targets: proxies,
        bindingKinds,
      }));
      for (const target of proxies) wrappers.push(targetSourceEdit(target));
    },
    onUpdate(node, shadowedNames) {
      if (
        node.argument.type !== 'Identifier'
        || !persistentNames.has(node.argument.name)
        || shadowedNames.has(node.argument.name)
      ) {
        return;
      }
      const name = node.argument.name;
      const kind = bindingKinds.get(name);
      if (node.prefix) {
        wrappers.push(valueCommitWrapper(node, commitIdentifier, name, kind));
        return;
      }
      const temporary = `${internalPrefix}result_${nextTemporary++}`;
      wrappers.push(resultPreservingCommitWrapper({
        node,
        temporary,
        commitIdentifier,
        targets: [name],
        bindingKinds,
      }));
    },
  });
  return wrappers;
}

function visitNode(node, shadowedNames, visitor) {
  if (!node || typeof node.type !== 'string') return;

  if (isFunctionNode(node)) {
    const functionShadowed = new Set(shadowedNames);
    for (const name of functionScopeBindings(node)) functionShadowed.add(name);
    for (const parameter of node.params ?? []) {
      for (const name of bindingNames(parameter)) functionShadowed.add(name);
    }
    if (node.type !== 'FunctionDeclaration' && node.id) functionShadowed.add(node.id.name);
    if (node.body) visitNode(node.body, functionShadowed, visitor);
    return;
  }

  if (node.type === 'BlockStatement') {
    const blockShadowed = new Set(shadowedNames);
    for (const name of directBlockLexicalBindings(node)) blockShadowed.add(name);
    for (const statement of node.body) visitNode(statement, blockShadowed, visitor);
    return;
  }

  if (node.type === 'CatchClause') {
    const catchShadowed = new Set(shadowedNames);
    for (const name of bindingNames(node.param)) catchShadowed.add(name);
    visitNode(node.body, catchShadowed, visitor);
    return;
  }

  if (
    node.type === 'ForStatement'
    || node.type === 'ForInStatement'
    || node.type === 'ForOfStatement'
  ) {
    const loopShadowed = new Set(shadowedNames);
    const declaration = node.type === 'ForStatement' ? node.init : node.left;
    if (declaration?.type === 'VariableDeclaration' && declaration.kind !== 'var') {
      for (const declarator of declaration.declarations) {
        for (const name of bindingNames(declarator.id)) loopShadowed.add(name);
      }
    }
    for (const child of childNodes(node)) visitNode(child, loopShadowed, visitor);
    return;
  }

  if (node.type === 'AssignmentExpression') visitor.onAssignment(node, shadowedNames);
  if (node.type === 'UpdateExpression') visitor.onUpdate(node, shadowedNames);
  for (const child of childNodes(node)) visitNode(child, shadowedNames, visitor);
}

function functionScopeBindings(node) {
  const names = new Set();
  const collect = (candidate) => {
    if (!candidate || typeof candidate.type !== 'string') return;
    if (candidate !== node && isFunctionNode(candidate)) return;
    if (candidate.type === 'VariableDeclaration' && candidate.kind === 'var') {
      for (const declarator of candidate.declarations) {
        for (const name of bindingNames(declarator.id)) names.add(name);
      }
    } else if (candidate.type === 'FunctionDeclaration' && candidate.id) {
      names.add(candidate.id.name);
    }
    for (const child of childNodes(candidate)) collect(child);
  };
  collect(node.body);
  return names;
}

function directBlockLexicalBindings(block) {
  const names = new Set();
  for (const statement of block.body) {
    const declaration = statement.type === 'ExportNamedDeclaration'
      || statement.type === 'ExportDefaultDeclaration'
      ? statement.declaration
      : statement;
    if (declaration?.type === 'VariableDeclaration' && declaration.kind !== 'var') {
      for (const declarator of declaration.declarations) {
        for (const name of bindingNames(declarator.id)) names.add(name);
      }
    } else if (
      (declaration?.type === 'ClassDeclaration' || declaration?.type === 'FunctionDeclaration')
      && declaration.id
    ) {
      names.add(declaration.id.name);
    }
  }
  return names;
}

function childNodes(node) {
  const children = [];
  for (const [key, value] of Object.entries(node)) {
    if (['end', 'loc', 'range', 'start', 'type'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item.type === 'string') children.push(item);
      }
    } else if (value && typeof value.type === 'string') {
      children.push(value);
    }
  }
  return children;
}

function renderSourceRange(source, start, end, wrappers) {
  const editor = new SourceEditor(source.slice(start, end));
  for (const wrapper of wrappers) {
    if (wrapper.start < start || wrapper.end > end) continue;
    applySourceEdit(editor, {
      ...wrapper,
      start: wrapper.start - start,
      end: wrapper.end - start,
    });
  }
  return editor.apply();
}

function applySourceEdit(editor, edit) {
  if (edit.editType === 'replace') {
    editor.replace(edit.start, edit.end, edit.text);
  } else if (edit.editType === 'insert') {
    editor.insert(edit.start, edit.text);
  } else {
    editor.insert(edit.start, edit.prefix);
    editor.insert(edit.end, edit.suffix);
  }
}

function valueCommitWrapper(node, commitIdentifier, name, kind) {
  return {
    start: node.start,
    end: node.end,
    prefix: `${commitIdentifier}(${JSON.stringify(name)}, ${JSON.stringify(kind)}, (`,
    suffix: '))',
    claimed: false,
  };
}

function resultPreservingCommitWrapper({
  node,
  temporary,
  commitIdentifier,
  targets,
  bindingKinds,
}) {
  const commits = targets.map((name) => (
    commitStatement(commitIdentifier, name, bindingKinds.get(name))
  )).join('');
  return {
    start: node.start,
    end: node.end,
    prefix: `(()=>{const ${temporary}=(`,
    suffix: `);${commits}return ${temporary};})()`,
    claimed: false,
  };
}

function destructuringCommitWrapper({
  node,
  temporary,
  commitIdentifier,
  targets,
  bindingKinds,
}) {
  const setters = targets.map(({ name, proxy, assigned }) => (
    `const ${proxy}={set value(${assigned}){${name}=${assigned};${commitStatement(
      commitIdentifier,
      name,
      bindingKinds.get(name),
    )}}};`
  )).join('');
  return {
    start: node.start,
    end: node.end,
    prefix: `(()=>{${setters}const ${temporary}=(`,
    suffix: `);return ${temporary};})()`,
    claimed: false,
  };
}

function assignmentTargetRecords(target, output = [], shorthandProperty) {
  if (!target) return output;
  switch (target.type) {
    case 'Identifier':
      output.push({
        name: target.name,
        start: shorthandProperty ? shorthandProperty.key.end : target.start,
        end: shorthandProperty ? shorthandProperty.key.end : target.end,
        shorthand: Boolean(shorthandProperty),
      });
      break;
    case 'AssignmentPattern':
      assignmentTargetRecords(target.left, output, shorthandProperty);
      break;
    case 'RestElement':
      assignmentTargetRecords(target.argument, output);
      break;
    case 'ArrayPattern':
      for (const element of target.elements) assignmentTargetRecords(element, output);
      break;
    case 'ObjectPattern':
      for (const property of target.properties) {
        if (property.type === 'RestElement') {
          assignmentTargetRecords(property.argument, output);
        } else {
          assignmentTargetRecords(
            property.value,
            output,
            property.shorthand ? property : undefined,
          );
        }
      }
      break;
    default:
      break;
  }
  return output;
}

function targetSourceEdit(target) {
  if (target.shorthand) {
    return {
      editType: 'insert',
      start: target.start,
      end: target.end,
      text: `: ${target.proxy}.value`,
      claimed: false,
    };
  }
  return {
    editType: 'replace',
    start: target.start,
    end: target.end,
    text: `${target.proxy}.value`,
    claimed: false,
  };
}

function assignmentTargetNames(target, output = []) {
  if (!target) return output;
  switch (target.type) {
    case 'Identifier':
      output.push(target.name);
      break;
    case 'AssignmentPattern':
      assignmentTargetNames(target.left, output);
      break;
    case 'RestElement':
      assignmentTargetNames(target.argument, output);
      break;
    case 'ArrayPattern':
      for (const element of target.elements) assignmentTargetNames(element, output);
      break;
    case 'ObjectPattern':
      for (const property of target.properties) {
        assignmentTargetNames(
          property.type === 'RestElement' ? property.argument : property.value,
          output,
        );
      }
      break;
    default:
      // Member assignments are side effects but do not replace a persisted binding.
      break;
  }
  return output;
}

function collectTopLevelLoopVarBindings(declaration, add) {
  if (declaration.kind !== 'var') return;
  for (const declarator of declaration.declarations) {
    for (const name of bindingNames(declarator.id)) add(name, 'var');
  }
}

function instrumentTopLevelLoops({
  ast,
  editor,
  bindingKinds,
  commitIdentifier,
}) {
  for (const item of ast.body) {
    if (item.type === 'ForStatement') {
      const declaration = item.init;
      if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'var') continue;
      for (const declarator of declaration.declarations) {
        const names = bindingNames(declarator.id).filter((name) => bindingKinds.has(name));
        if (names.length !== 1 || declarator.id.type !== 'Identifier') continue;
        const name = names[0];
        if (declarator.init) {
          editor.insert(
            declarator.init.start,
            `${commitIdentifier}(${JSON.stringify(name)}, "var", (`,
          );
          editor.insert(declarator.init.end, '))');
        } else {
          editor.insert(
            declarator.end,
            ` = ${commitIdentifier}(${JSON.stringify(name)}, "var", undefined)`,
          );
        }
      }
      continue;
    }
    if (item.type !== 'ForInStatement' && item.type !== 'ForOfStatement') continue;
    const targets = loopAssignmentTargets(item.left)
      .filter((name) => bindingKinds.has(name));
    if (targets.length === 0) continue;
    const markers = targets.map((name) => (
      commitStatement(commitIdentifier, name, bindingKinds.get(name))
    )).join('\n');
    if (item.body.type === 'BlockStatement') {
      editor.insert(item.body.start + 1, `\n${markers}\n`);
    } else {
      editor.insert(item.body.start, `{\n${markers}\n`);
      editor.insert(item.body.end, '\n}');
    }
  }
}

function loopAssignmentTargets(left) {
  if (left?.type === 'VariableDeclaration') {
    if (left.kind !== 'var') return [];
    return left.declarations.flatMap((declarator) => bindingNames(declarator.id));
  }
  return assignmentTargetNames(left);
}

function commitStatement(identifier, name, kind) {
  return `${identifier}(${JSON.stringify(name)}, ${JSON.stringify(kind)}, ${name});`;
}

function isFunctionNode(node) {
  return node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression';
}

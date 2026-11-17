// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const methods = new Set(['debug', 'info', 'warn', 'error', 'fatal', 'trace', 'log']);

export function checkSource(source, filename = 'source.ts') {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const calls = [];
  const exceptionIn = (node, exceptions) => {
    if (ts.isIdentifier(node) && exceptions.has(node.text)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return exceptionIn(node.expression, exceptions);
    if (ts.isPropertyAssignment(node)) return exceptionIn(node.initializer, exceptions);
    return ts.forEachChild(node, (child) => exceptionIn(child, exceptions));
  };
  const wholeExceptionIn = (node, whole) => {
    if (ts.isTypeOfExpression(node)) return undefined;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)
      return undefined;
    if (ts.isConditionalExpression(node))
      return wholeExceptionIn(node.whenTrue, whole) || wholeExceptionIn(node.whenFalse, whole);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return undefined;
    if (ts.isIdentifier(node)) return whole.has(node.text) ? node.text : undefined;
    if (
      ts.isCallExpression(node) &&
      !['String', 'JSON.stringify'].includes(node.expression.getText(file))
    )
      return undefined;
    return ts.forEachChild(node, (child) => wholeExceptionIn(child, whole));
  };
  function visit(node, inherited, inheritedWhole) {
    let exceptions = inherited;
    let whole = inheritedWhole;
    if (ts.isCatchClause(node)) {
      exceptions = new Set(inherited);
      whole = new Set(inheritedWhole);
      if (node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
        exceptions.add(node.variableDeclaration.name.text);
        whole.add(node.variableDeclaration.name.text);
      }
    }
    if (ts.isFunctionLike(node)) {
      exceptions = new Set(inherited);
      whole = new Set(inheritedWhole);
      const parent = node.parent;
      const rejection =
        ts.isCallExpression(parent) &&
        ts.isPropertyAccessExpression(parent.expression) &&
        (parent.expression.name.text === 'catch' ||
          (parent.expression.name.text === 'then' && parent.arguments[1] === node) ||
          (['on', 'once'].includes(parent.expression.name.text) &&
            parent.arguments[0]?.text === 'error'));
      for (const parameter of node.parameters) {
        if (!ts.isIdentifier(parameter.name)) continue;
        exceptions.delete(parameter.name.text);
        whole.delete(parameter.name.text);
        if (rejection || /\b\w*(Error|Exception)\b/.test(parameter.type?.getText(file) ?? '')) {
          exceptions.add(parameter.name.text);
          whole.add(parameter.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (
        exceptionIn(node.initializer, exceptions) ||
        (ts.isNewExpression(node.initializer) &&
          /(?:Error|Exception)$/.test(node.initializer.expression.getText(file))) ||
        (ts.isCallExpression(node.initializer) &&
          /(?:errorFromFrame|toError|asError)$/.test(node.initializer.expression.getText(file)))
      )
        exceptions.add(node.name.text);
      else exceptions.delete(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const raw =
        wholeExceptionIn(node.initializer, whole) ||
        (ts.isNewExpression(node.initializer) &&
          /(?:Error|Exception)$/.test(node.initializer.expression.getText(file))) ||
        (ts.isCallExpression(node.initializer) &&
          /(?:errorFromFrame|toError|asError)$/.test(node.initializer.expression.getText(file)));
      if (raw) whole.add(node.name.text);
      else whole.delete(node.name.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      methods.has(node.expression.name.text)
    ) {
      const target = node.expression.expression.getText(file);
      if (/log|console/i.test(target)) {
        const args = node.arguments;
        const structured = args[0] && ts.isObjectLiteralExpression(args[0]);
        const rawException =
          args.length > 1 && ts.isIdentifier(args[0]) && exceptions.has(args[0].text);
        const messageArgs =
          !target.includes('console') && (structured || rawException) ? args.slice(1) : args;
        const exception = messageArgs.map((arg) => exceptionIn(arg, exceptions)).find(Boolean);
        if (structured && !target.includes('console')) {
          for (const property of args[0].properties) {
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
              continue;
            const key = property.name.text;
            if (['error', 'err'].includes(key) || /(^|\.)pii(\.|$)/i.test(key)) continue;
            const raw = wholeExceptionIn(
              ts.isPropertyAssignment(property) ? property.initializer : property.name,
              whole,
            );
            if (raw)
              calls.push({
                line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
                exception: raw,
              });
          }
        }
        if (exception)
          calls.push({
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            exception,
          });
      }
    }
    ts.forEachChild(node, (child) => visit(child, exceptions, whole));
  }
  visit(file, new Set(), new Set());
  return calls;
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (['node_modules', 'dist', '.git'].includes(entry.name)) return [];
    return entry.isDirectory()
      ? files(path)
      : path.endsWith('.ts') && !path.endsWith('.test.ts')
        ? [path]
        : [];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (const file of [...files(join(root, 'agents/src')), ...files(join(root, 'plugins'))]) {
    for (const { line, exception } of checkSource(readFileSync(file, 'utf8'), file)) {
      console.error(
        `${file}:${line}: exception '${exception}' in log message; use { error } instead`,
      );
      process.exitCode = 1;
    }
  }
}

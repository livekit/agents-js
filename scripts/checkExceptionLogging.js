// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const methods = new Set(['debug', 'info', 'warn', 'error', 'fatal', 'trace', 'log']);
const errorNames = /^(e|err|error|exc|exception|failure)$/i;

export function checkSource(source, filename = 'source.ts') {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const calls = [];
  const exceptionIn = (node, exceptions) => {
    if (ts.isIdentifier(node) && exceptions.has(node.text)) return node.text;
    if (ts.isPropertyAccessExpression(node)) {
      if (
        node.name.text === 'errorDetails' ||
        (node.name.text === 'message' &&
          ts.isIdentifier(node.expression) &&
          errorNames.test(node.expression.text))
      )
        return node.expression.getText(file);
      return exceptionIn(node.expression, exceptions);
    }
    if (ts.isPropertyAssignment(node)) return exceptionIn(node.initializer, exceptions);
    return ts.forEachChild(node, (child) => exceptionIn(child, exceptions));
  };
  function visit(node, inherited) {
    let exceptions = inherited;
    if (ts.isCatchClause(node)) {
      exceptions = new Set(inherited);
      if (node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
        exceptions.add(node.variableDeclaration.name.text);
      }
    }
    if (ts.isFunctionLike(node)) {
      exceptions = new Set(inherited);
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
        if (
          rejection ||
          errorNames.test(parameter.name.text) ||
          /\b\w*(Error|Exception)\b/.test(parameter.type?.getText(file) ?? '')
        ) {
          exceptions.add(parameter.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (
        exceptionIn(node.initializer, exceptions) ||
        (ts.isNewExpression(node.initializer) &&
          /(?:Error|Exception)$/.test(node.initializer.expression.getText(file)))
      )
        exceptions.add(node.name.text);
      else exceptions.delete(node.name.text);
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
        if (exception)
          calls.push({
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            exception,
          });
      }
    }
    ts.forEachChild(node, (child) => visit(child, exceptions));
  }
  visit(file, new Set());
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

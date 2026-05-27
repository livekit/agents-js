// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * @name Missing return type on public API
 * @description An exported function or public method has no explicit return type annotation.
 *              CodeQL's TypeScript resolver (since 2.22.2) has no access to compiler-inferred
 *              types, so the forgotten-export check can only see internal types named in
 *              explicit annotations. Requiring return types on the public API keeps that
 *              check meaningful and matches what API Extractor saw via the TS compiler.
 * @kind problem
 * @problem.severity warning
 * @id livekit/missing-public-return-type
 * @tags maintainability
 */

import javascript

predicate isExportedName(LexicalName n) { exists(ES2015Module m | m.exportsAs(n, _)) }

/** A function/method that forms part of a published package's public API. */
predicate publicApiFunction(Function f, string what) {
  // exported `function` declaration
  exists(FunctionDeclStmt fds |
    fds = f and isExportedName(fds.getVariable()) and what = "exported function " + fds.getName()
  )
  or
  // arrow/function expression assigned to an exported binding, unless the binding itself
  // carries an explicit type annotation (e.g. `const cb: TextInputCallback = () => …`),
  // which already fully specifies the signature including the return type.
  exists(VarDecl vd |
    isExportedName(vd.getVariable()) and
    f = vd.getVariable().getAnAssignedExpr() and
    not exists(vd.getTypeAnnotation()) and
    what = "exported function " + vd.getName()
  )
  or
  // public method or getter of an exported class/interface
  exists(MethodDeclaration md, ClassOrInterface ci |
    md.getDeclaringType() = ci and
    f = md.getBody() and
    isExportedName(ci.getIdentifier().(TypeDecl).getLocalTypeName()) and
    not md.isPrivate() and
    not md.isProtected() and
    not md instanceof ConstructorDeclaration and
    not md instanceof SetterMethodDeclaration and
    not md.getName().matches("#%") and
    what = ci.getName() + "." + md.getName()
  )
}

from Function f, string what
where
  publicApiFunction(f, what) and
  not exists(f.getReturnTypeAnnotation()) and
  not f.getTopLevel().isExterns() and
  not f.getFile().getAbsolutePath().matches("%/node_modules/%")
select f, "Public API " + what + " has no explicit return type annotation."

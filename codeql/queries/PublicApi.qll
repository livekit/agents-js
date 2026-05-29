// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for the public-API checks. "Public API" means the names a published
 * package exposes through its entry point and the type-annotation positions that form
 * their contract (function parameters/returns and public members of exported types).
 */

import javascript

/** Holds if `f` is the entry point of a published package (`agents` or a plugin). */
predicate isPackageEntryPoint(File f) {
  f.getBaseName() = "index.ts" and
  f.getRelativePath().regexpMatch("(agents|plugins/[^/]+)/src/index\\.ts") and
  // `plugins/test` is a private test-only mock package, not published
  not f.getRelativePath().matches("plugins/test/%")
}

/**
 * Holds if `n` is part of a published package's public API: exported (directly or via
 * re-export) from a package entry point. A name merely exported from an internal module
 * (e.g. a plugin's `log.ts` that `index.ts` never re-exports) is NOT public API.
 */
predicate isExportedName(LexicalName n) {
  exists(ES2015Module entry | isPackageEntryPoint(entry.getFile()) and entry.exportsAs(n, _))
}

/** Holds if `n` lives in source that ships to consumers (not externs, deps, or test mocks). */
predicate inPublishedSource(AstNode n) {
  not n.getTopLevel().isExterns() and
  not n.getFile().getAbsolutePath().matches("%/node_modules/%") and
  // `plugins/test` is a private test-only mock package, not published
  not n.getFile().getRelativePath().matches("plugins/test/%")
}

/** Holds if `n` sits in the body of a function rather than in a public signature. */
predicate inFunctionBody(AstNode n) { exists(Function f | n.getParent+() = f.getBody()) }

/** Holds if `n` sits inside a non-public (private/protected) class member. */
predicate inNonPublicMember(AstNode n) {
  exists(MemberDeclaration m | (m.isPrivate() or m.isProtected()) and n.getParent+() = m)
}

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

/**
 * Holds if the type expression `te` occupies a public-API signature position, with `what`
 * describing the enclosing API element. Covers (a) any annotation within the declaration of
 * an exported type, excluding private members and function bodies, and (b) the parameter and
 * return annotations of an exported function or public method.
 */
predicate publicSignatureType(TypeExpr te, string what) {
  // Inside the declaration of an exported type but outside any function — e.g. an interface
  // property, a type-alias body, or a class field type. (Function signatures are handled by the
  // branch below; making the two mutually exclusive keeps exactly one `what` per node, otherwise
  // CodeQL merges the same-location alerts into one multi-line message.)
  exists(LocalTypeName container |
    isExportedName(container) and
    te.getParent+() = container.getADeclaration().getParent() and
    not exists(Function fn | te.getParent+() = fn) and
    not inNonPublicMember(te) and
    what = container.getName()
  )
  or
  // A parameter or return annotation of an exported function or public method.
  exists(Function f |
    publicApiFunction(f, what) and
    te.getParent+() = f and
    not inFunctionBody(te)
  )
}

// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * @name Forgotten export
 * @description A type referenced by an exported declaration is itself declared in this
 *              repository but not exported, so consumers of the public API cannot name it.
 *              Mirrors API Extractor's `ae-forgotten-export` check.
 * @kind problem
 * @problem.severity warning
 * @id livekit/forgotten-export
 * @tags maintainability
 */

import javascript

/** Holds if `tn` is exported (directly or via re-export) from some module. */
predicate isExported(LocalTypeName tn) { exists(ES2015Module m | m.exportsAs(tn, _)) }

/** Holds if `tn` is a named type declared in this repo's own (non-external) sources. */
predicate isLocalProjectType(LocalTypeName tn) {
  exists(TypeDecl decl |
    decl = tn.getADeclaration() and
    not decl.getTopLevel().isExterns() and
    not decl.getFile().getAbsolutePath().matches("%/node_modules/%") and
    // not a type parameter (those are inherently local to their declaration)
    not decl = any(TypeParameter tp).getIdentifier() and
    // not an alias introduced by an import (that type belongs to another package)
    not decl = any(ImportSpecifier im).getLocal() and
    not decl = any(ImportEqualsDeclaration im).getIdentifier()
  )
}

/** The AST node that declares the exported type `tn` (class/interface/alias/enum body). */
AstNode exportedTypeDeclaration(LocalTypeName tn) {
  isExported(tn) and
  result = tn.getADeclaration().getParent()
}

/** Holds if `ta` sits in the body of a function rather than in a public signature. */
predicate inFunctionBody(LocalTypeAccess ta) {
  exists(Function f | ta.getParent+() = f.getBody())
}

/** Holds if `ta` sits inside a non-public (private/protected) class member. */
predicate inNonPublicMember(LocalTypeAccess ta) {
  exists(MemberDeclaration m |
    (m.isPrivate() or m.isProtected()) and
    ta.getParent+() = m
  )
}

from LocalTypeAccess ta, LocalTypeName referenced, LocalTypeName container
where
  referenced = ta.getLocalTypeName() and
  isLocalProjectType(referenced) and
  not isExported(referenced) and
  container != referenced and
  // the reference appears within the declaration of an exported type ...
  ta.getParent+() = exportedTypeDeclaration(container) and
  // ... in a public-signature position
  not inFunctionBody(ta) and
  not inNonPublicMember(ta)
select ta,
  "Type '" + referenced.getName() + "' is part of the public API (referenced by exported '" +
    container.getName() + "') but is not exported."

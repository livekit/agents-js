// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * @name Public API signatures (raw locations)
 * @description Emits one row per declaration slot of the public API — function/method
 *              parameter, return type, generic parameter list, interface/class field, enum
 *              body, type-alias RHS, and exported constant — with the source location of
 *              each annotation. The runner in `scripts/codeql-api-check.ts` reads those
 *              ranges and reconstructs full signature/declaration strings into the snapshot.
 *              CodeQL's `TypeExpr.toString()` and `BindingPattern.toString()` both truncate
 *              long text, so we extract surface text directly. Paired with `api-surface`
 *              (names) this catches drift in parameter renames/reorderings, type changes,
 *              return-type changes, interface property changes, enum member changes, type
 *              alias bodies, and constant type annotations.
 * @kind table
 * @id livekit/api-signatures
 * @tags maintainability
 */

import javascript
import PublicApi

string packageRoot(File f) {
  result = f.getRelativePath().regexpCapture("^(agents|plugins/[^/]+)/.*", 1)
}

/** Two-digit zero-padded index. Public APIs don't have ≥100 params, so this is enough. */
bindingset[i]
string paddedIndex(int i) {
  if i < 10 then result = "0" + i.toString() else result = i.toString()
}

/** Stable per-AST-node key so overloaded methods don't collapse into a single signature. */
string nodeKey(AstNode n) {
  result =
    n.getFile().getRelativePath() + ":" + n.getLocation().getStartLine() + ":" +
      n.getLocation().getStartColumn()
}

/** Source range covering a TypeParameterized node's type parameters (excluding `< >`). */
predicate typeParamsRange(
  TypeParameterized tp, string file, int sLine, int sCol, int eLine, int eCol
) {
  exists(TypeParameter first, TypeParameter last, int n |
    n = count(tp.getATypeParameter()) and
    n > 0 and
    first = tp.getTypeParameter(0) and
    last = tp.getTypeParameter(n - 1) and
    file = first.getFile().getRelativePath() and
    sLine = first.getLocation().getStartLine() and
    sCol = first.getLocation().getStartColumn() and
    eLine = last.getLocation().getEndLine() and
    eCol = last.getLocation().getEndColumn()
  )
}

/** Source range covering an enum's member list (first to last member; no surrounding braces). */
predicate enumMembersRange(
  EnumDeclaration e, string file, int sLine, int sCol, int eLine, int eCol
) {
  exists(EnumMember first, EnumMember last, int n |
    n = e.getNumMember() and
    n > 0 and
    first = e.getMember(0) and
    last = e.getMember(n - 1) and
    file = first.getFile().getRelativePath() and
    sLine = first.getLocation().getStartLine() and
    sCol = first.getLocation().getStartColumn() and
    eLine = last.getLocation().getEndLine() and
    eCol = last.getLocation().getEndColumn()
  )
}

string classOrInterfaceKind(ClassOrInterface c) {
  c instanceof ClassDefinition and result = "class"
  or
  c instanceof InterfaceDeclaration and result = "interface"
}

string paramFlags(Parameter p) {
  exists(string rest, string opt |
    (if p.isRestParameter() then rest = "rest" else rest = "") and
    (if p.isDeclaredOptional() then opt = "opt" else opt = "") and
    (
      result = rest + "+" + opt and rest != "" and opt != ""
      or
      result = rest and opt = "" and rest != ""
      or
      result = opt and rest = "" and opt != ""
      or
      result = "" and rest = "" and opt = ""
    )
  )
}

string fieldFlags(FieldDeclaration fd) {
  exists(string ro, string opt |
    (if fd.isReadonly() then ro = "readonly" else ro = "") and
    (if fd.isOptional() then opt = "opt" else opt = "") and
    (
      result = ro + "+" + opt and ro != "" and opt != ""
      or
      result = ro and opt = "" and ro != ""
      or
      result = opt and ro = "" and opt != ""
      or
      result = "" and ro = "" and opt = ""
    )
  )
}

/**
 * One row per signature slot. The slot kind controls how the runner renders it; locations
 * with empty `file` and zero lines/columns mean "no annotation" (the runner renders those
 * as `<unannotated>` / `<inferred>`).
 *
 * Slot kinds:
 *   - `param-NN` / `return` / `generics`     → combined into one function signature line
 *   - `class-generics`                       → standalone `{class|interface|type} Foo<...>`
 *   - `type-alias`                           → standalone `type Foo = ...` (combined with
 *                                              `class-generics` for generic aliases)
 *   - `prop-<name>`                          → standalone `{class|interface} Foo.bar: Type`
 *   - `enum-body`                            → standalone `enum Foo { members }`
 *   - `const`                                → standalone `const FOO: Type`
 */
predicate signatureRow(
  string package, string qname, string nodeId, string slot, string flags, string bFile,
  int bSLine, int bSCol, int bELine, int bECol, string tFile, int tSLine, int tSCol, int tELine,
  int tECol
) {
  // function/method parameters
  exists(Function f, Parameter p, int i, string what |
    publicApiFunction(f, what) and
    inPublishedSource(f) and
    p = f.getParameter(i) and
    package = packageRoot(f.getFile()) and
    qname = what and
    nodeId = nodeKey(f) and
    slot = "param-" + paddedIndex(i) and
    flags = paramFlags(p) and
    bFile = p.getFile().getRelativePath() and
    bSLine = p.getLocation().getStartLine() and
    bSCol = p.getLocation().getStartColumn() and
    bELine = p.getLocation().getEndLine() and
    bECol = p.getLocation().getEndColumn() and
    (
      exists(TypeExpr te | te = p.getTypeAnnotation() |
        tFile = te.getFile().getRelativePath() and
        tSLine = te.getLocation().getStartLine() and
        tSCol = te.getLocation().getStartColumn() and
        tELine = te.getLocation().getEndLine() and
        tECol = te.getLocation().getEndColumn()
      )
      or
      not exists(p.getTypeAnnotation()) and
      tFile = "" and
      tSLine = 0 and
      tSCol = 0 and
      tELine = 0 and
      tECol = 0
    )
  )
  or
  // function/method return type
  exists(Function f, string what |
    publicApiFunction(f, what) and
    inPublishedSource(f) and
    package = packageRoot(f.getFile()) and
    qname = what and
    nodeId = nodeKey(f) and
    slot = "return" and
    flags = "" and
    bFile = "" and
    bSLine = 0 and
    bSCol = 0 and
    bELine = 0 and
    bECol = 0 and
    (
      exists(TypeExpr te | te = f.getReturnTypeAnnotation() |
        tFile = te.getFile().getRelativePath() and
        tSLine = te.getLocation().getStartLine() and
        tSCol = te.getLocation().getStartColumn() and
        tELine = te.getLocation().getEndLine() and
        tECol = te.getLocation().getEndColumn()
      )
      or
      not exists(f.getReturnTypeAnnotation()) and
      tFile = "" and
      tSLine = 0 and
      tSCol = 0 and
      tELine = 0 and
      tECol = 0
    )
  )
  or
  // function/method-level type parameters (`function foo<T>(...)`, `method bar<T extends U>(...)`)
  exists(Function f, string what |
    publicApiFunction(f, what) and
    inPublishedSource(f) and
    package = packageRoot(f.getFile()) and
    qname = what and
    nodeId = nodeKey(f) and
    slot = "generics" and
    flags = "" and
    typeParamsRange(f, bFile, bSLine, bSCol, bELine, bECol) and
    tFile = "" and
    tSLine = 0 and
    tSCol = 0 and
    tELine = 0 and
    tECol = 0
  )
  or
  // class/interface-level type parameters
  exists(ClassOrInterface c, LocalTypeName tn |
    tn = c.getIdentifier().(TypeDecl).getLocalTypeName() and
    isExportedName(tn) and
    inPublishedSource(c) and
    package = packageRoot(c.getFile()) and
    qname = classOrInterfaceKind(c) + " " + c.getName() and
    nodeId = nodeKey(c) and
    slot = "class-generics" and
    flags = "" and
    typeParamsRange(c, bFile, bSLine, bSCol, bELine, bECol) and
    tFile = "" and
    tSLine = 0 and
    tSCol = 0 and
    tELine = 0 and
    tECol = 0
  )
  or
  // type-alias-level type parameters (`type Foo<T> = ...`)
  exists(TypeAliasDeclaration tad |
    isExportedName(tad.getIdentifier().(TypeDecl).getLocalTypeName()) and
    inPublishedSource(tad) and
    package = packageRoot(tad.getFile()) and
    qname = "type " + tad.getName() and
    nodeId = nodeKey(tad) and
    slot = "class-generics" and
    flags = "" and
    typeParamsRange(tad, bFile, bSLine, bSCol, bELine, bECol) and
    tFile = "" and
    tSLine = 0 and
    tSCol = 0 and
    tELine = 0 and
    tECol = 0
  )
  or
  // type alias RHS (`type Foo = string | number`)
  exists(TypeAliasDeclaration tad, TypeExpr def |
    isExportedName(tad.getIdentifier().(TypeDecl).getLocalTypeName()) and
    inPublishedSource(tad) and
    def = tad.getDefinition() and
    package = packageRoot(tad.getFile()) and
    qname = "type " + tad.getName() and
    nodeId = nodeKey(tad) and
    slot = "type-alias" and
    flags = "" and
    bFile = def.getFile().getRelativePath() and
    bSLine = def.getLocation().getStartLine() and
    bSCol = def.getLocation().getStartColumn() and
    bELine = def.getLocation().getEndLine() and
    bECol = def.getLocation().getEndColumn() and
    tFile = "" and
    tSLine = 0 and
    tSCol = 0 and
    tELine = 0 and
    tECol = 0
  )
  or
  // enum body (`enum Color { A = 'a', B = 'b' }`)
  exists(EnumDeclaration e |
    isExportedName(e.getVariable()) and
    inPublishedSource(e) and
    package = packageRoot(e.getFile()) and
    qname = "enum " + e.getName() and
    nodeId = nodeKey(e) and
    slot = "enum-body" and
    flags = "" and
    enumMembersRange(e, bFile, bSLine, bSCol, bELine, bECol) and
    tFile = "" and
    tSLine = 0 and
    tSCol = 0 and
    tELine = 0 and
    tECol = 0
  )
  or
  // interface or class property — one row per non-method field on the exported type
  exists(ClassOrInterface c, FieldDeclaration fd, LocalTypeName tn |
    tn = c.getIdentifier().(TypeDecl).getLocalTypeName() and
    isExportedName(tn) and
    inPublishedSource(c) and
    fd = c.getAField() and
    not fd.isPrivate() and
    not fd.isProtected() and
    not fd.getName().matches("#%") and
    not fd.isComputed() and
    package = packageRoot(c.getFile()) and
    qname = classOrInterfaceKind(c) + " " + c.getName() and
    nodeId = nodeKey(c) and
    slot = "prop-" + fd.getName() and
    flags = fieldFlags(fd) and
    bFile = "" and
    bSLine = 0 and
    bSCol = 0 and
    bELine = 0 and
    bECol = 0 and
    (
      exists(TypeExpr te | te = fd.getTypeAnnotation() |
        tFile = te.getFile().getRelativePath() and
        tSLine = te.getLocation().getStartLine() and
        tSCol = te.getLocation().getStartColumn() and
        tELine = te.getLocation().getEndLine() and
        tECol = te.getLocation().getEndColumn()
      )
      or
      not exists(TypeExpr te | te = fd.getTypeAnnotation()) and
      tFile = "" and
      tSLine = 0 and
      tSCol = 0 and
      tELine = 0 and
      tECol = 0
    )
  )
  or
  // exported `const NAME: Type = ...` declarations (only true `const` statements — class /
  // function / enum declarations introduce a Variable too but live in their own branches).
  // Skip when the initializer is a Function expression and there's no explicit annotation, as
  // that case is already covered by `publicApiFunction`'s arrow-binding branch.
  exists(VarDecl vd, VariableDeclarator vdr |
    vdr.getBindingPattern() = vd and
    vdr.getDeclStmt() instanceof ConstDeclStmt and
    isExportedName(vd.getVariable()) and
    inPublishedSource(vd) and
    not (exists(Function f | f = vdr.getInit()) and not exists(vdr.getTypeAnnotation())) and
    package = packageRoot(vd.getFile()) and
    qname = "const " + vd.getName() and
    nodeId = nodeKey(vd) and
    slot = "const" and
    flags = "" and
    bFile = "" and
    bSLine = 0 and
    bSCol = 0 and
    bELine = 0 and
    bECol = 0 and
    (
      exists(TypeExpr te | te = vdr.getTypeAnnotation() |
        tFile = te.getFile().getRelativePath() and
        tSLine = te.getLocation().getStartLine() and
        tSCol = te.getLocation().getStartColumn() and
        tELine = te.getLocation().getEndLine() and
        tECol = te.getLocation().getEndColumn()
      )
      or
      not exists(TypeExpr te | te = vdr.getTypeAnnotation()) and
      tFile = "" and
      tSLine = 0 and
      tSCol = 0 and
      tELine = 0 and
      tECol = 0
    )
  )
}

from
  string package, string qname, string nodeId, string slot, string flags, string bFile,
  int bSLine, int bSCol, int bELine, int bECol, string tFile, int tSLine, int tSCol, int tELine,
  int tECol
where
  signatureRow(package, qname, nodeId, slot, flags, bFile, bSLine, bSCol, bELine, bECol, tFile,
    tSLine, tSCol, tELine, tECol)
select package, qname, nodeId, slot, flags, bFile, bSLine, bSCol, bELine, bECol, tFile, tSLine,
  tSCol, tELine, tECol
order by package, qname, nodeId, slot

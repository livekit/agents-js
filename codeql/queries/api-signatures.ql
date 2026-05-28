// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * @name Public API signatures (raw locations)
 * @description Emits one row per parameter or return-type slot of every exported function
 *              and public method, with the source location of each annotation. The runner
 *              in `scripts/codeql-api-check.mjs` reads those ranges and reconstructs full
 *              signature strings into the snapshot — CodeQL's `TypeExpr.toString()` and
 *              `BindingPattern.toString()` both truncate long text, so we extract surface
 *              text directly. Paired with `api-surface` (names) this catches signature
 *              drift — parameter renames/reorderings, type changes, return-type changes —
 *              that the name-only snapshot misses.
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

/** Stable per-function key so overloaded methods don't collapse into a single signature. */
string functionKey(Function f) {
  result =
    f.getFile().getRelativePath() + ":" + f.getLocation().getStartLine() + ":" +
      f.getLocation().getStartColumn()
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

/**
 * One row per signature slot: parameter (`param-NN`) or return (`return`). Each row carries
 * the source location of the binding pattern (params only) and the type annotation (when
 * present). Locations with empty `file` and zero lines/columns mean "no annotation" — the
 * runner renders those as `<unannotated>` / `<inferred>`.
 */
predicate signatureRow(
  string package, string qname, string funcKey, string slot, string flags, string bFile,
  int bSLine, int bSCol, int bELine, int bECol, string tFile, int tSLine, int tSCol, int tELine,
  int tECol
) {
  exists(Function f, Parameter p, int i, string what |
    publicApiFunction(f, what) and
    inPublishedSource(f) and
    p = f.getParameter(i) and
    package = packageRoot(f.getFile()) and
    qname = what and
    funcKey = functionKey(f) and
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
  exists(Function f, string what |
    publicApiFunction(f, what) and
    inPublishedSource(f) and
    package = packageRoot(f.getFile()) and
    qname = what and
    funcKey = functionKey(f) and
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
}

from
  string package, string qname, string funcKey, string slot, string flags, string bFile,
  int bSLine, int bSCol, int bELine, int bECol, string tFile, int tSLine, int tSCol, int tELine,
  int tECol
where
  signatureRow(package, qname, funcKey, slot, flags, bFile, bSLine, bSCol, bELine, bECol, tFile,
    tSLine, tSCol, tELine, tECol)
select package, qname, funcKey, slot, flags, bFile, bSLine, bSCol, bELine, bECol, tFile, tSLine,
  tSCol, tELine, tECol
order by package, qname, funcKey, slot

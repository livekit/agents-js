// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * @name Public API leaks an undeclared dependency
 * @description A published package's public API references a type imported from a package
 *              that is not in its own `dependencies` or `peerDependencies`. This works inside
 *              the workspace but breaks for consumers who `npm install` the package, because
 *              the leaked type's package may not be present.
 * @kind problem
 * @problem.severity warning
 * @id livekit/undeclared-dependency-leak
 * @tags maintainability correctness
 */

import javascript
import PublicApi

/** Node's built-in modules, which are always available and need not be declared. */
predicate isNodeBuiltin(string name) {
  name =
    [
      "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "crypto", "dgram",
      "dns", "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net",
      "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl",
      "stream", "string_decoder", "timers", "tls", "trace_events", "tty", "url", "util", "v8",
      "vm", "wasi", "worker_threads", "zlib"
    ]
}

/** Gets the package name an import specifier resolves to (`@scope/pkg` or `pkg`). */
bindingset[path]
string packageOf(string path) {
  not path.matches(".%") and // relative
  not path.matches("node:%") and // explicit node builtin
  (
    if path.matches("@%")
    then result = path.regexpCapture("^(@[^/]+/[^/]+).*$", 1)
    else result = path.regexpCapture("^([^/]+).*$", 1)
  )
}

/** Gets the `package.json` JSON object that owns source file `f` in this monorepo layout. */
JsonObject owningPackageJson(File f) {
  result.isTopLevel() and
  exists(string root |
    root = f.getRelativePath().regexpCapture("^(agents|plugins/[^/]+)/.*$", 1) and
    result.getFile().getRelativePath() = root + "/package.json"
  )
}

/** Holds if `pkg` is declared as a runtime/peer dependency in `pkgJson`. */
predicate isDeclaredDependency(JsonObject pkgJson, string pkg) {
  exists(pkgJson.getPropValue("dependencies").getPropValue(pkg)) or
  exists(pkgJson.getPropValue("peerDependencies").getPropValue(pkg)) or
  pkg = pkgJson.getPropStringValue("name")
}

from LocalTypeAccess ta, string what, ImportDeclaration imp, string pkg, JsonObject pkgJson
where
  publicSignatureType(ta, what) and
  inPublishedSource(ta) and
  // the referenced type is brought in by an import ...
  imp.getASpecifier().getLocal() = ta.getLocalTypeName().getADeclaration() and
  pkg = packageOf(imp.getImportedPathString()) and
  not isNodeBuiltin(pkg) and
  // ... from a package the owning package.json does not declare
  pkgJson = owningPackageJson(ta.getFile()) and
  not isDeclaredDependency(pkgJson, pkg)
select ta,
  "Public API " + what + " references '" + ta.getName() + "' from '" + pkg +
    "', which is not a declared dependency of this package."

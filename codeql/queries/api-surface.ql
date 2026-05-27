// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * @name Public API surface
 * @description Lists every name exported from a published package's entry point
 *              (`<package>/src/index.ts`). The result is snapshotted to a committed
 *              baseline so unintended additions/removals show up as a diff, mirroring
 *              API Extractor's `.api.md` report.
 * @kind table
 * @id livekit/api-surface
 * @tags maintainability
 */

import javascript

/** Holds if `f` is the entry point of a published package (`agents` or a plugin). */
predicate isPackageEntryPoint(File f) {
  f.getBaseName() = "index.ts" and
  f.getRelativePath().regexpMatch("(agents|plugins/[^/]+)/src/index\\.ts") and
  // `plugins/test` is a private test-only mock package, not published
  not f.getRelativePath().matches("plugins/test/%")
}

from ES2015Module entry, string name
where
  isPackageEntryPoint(entry.getFile()) and
  entry.exportsAs(_, name) and
  name != "default"
select entry.getFile().getRelativePath() as package, name
order by package, name

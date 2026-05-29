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
import PublicApi

from ES2015Module entry, string name
where
  isPackageEntryPoint(entry.getFile()) and
  entry.exportsAs(_, name) and
  name != "default"
select entry.getFile().getRelativePath() as package, name
order by package, name

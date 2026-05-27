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
import PublicApi

from Function f, string what
where
  publicApiFunction(f, what) and
  not exists(f.getReturnTypeAnnotation()) and
  inPublishedSource(f)
select f, "Public API " + what + " has no explicit return type annotation."

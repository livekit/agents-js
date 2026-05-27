// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * @name `any`/`unknown` in public API
 * @description An exported function or public member uses `any` or `unknown` in a public
 *              type-annotation position. `any` opts out of type checking for consumers, and
 *              both top types can also hide an internal type that should have been exported
 *              (the inferred-type blind spot of the forgotten-export check). Prefer a precise,
 *              exported type.
 * @kind problem
 * @problem.severity warning
 * @id livekit/any-in-public-api
 * @tags maintainability
 */

import javascript
import PublicApi

from PredefinedTypeExpr kt, string what, string kind
where
  (kt.isAny() and kind = "any" or kt.isUnknownKeyword() and kind = "unknown") and
  publicSignatureType(kt, what) and
  inPublishedSource(kt)
select kt, "Public API " + what + " uses '" + kind + "' in a type annotation."

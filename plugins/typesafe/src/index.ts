// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { DecisionModel, type DecisionModelOptions } from './decision_model.js';
export type { DecisionModels, OpenRouterDecisionModels } from './models.js';

class TypeSafePlugin extends Plugin {
  constructor() {
    super({
      title: 'typesafe',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new TypeSafePlugin());

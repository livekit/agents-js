// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';

export class WebSearch {
  static create(): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'mistral_web_search',
      config: { type: 'web_search' },
    });
  }
}

export class DocumentLibrary {
  static create({ libraryIds }: { libraryIds: string[] }): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'mistral_document_library',
      config: { type: 'document_library', library_ids: libraryIds },
    });
  }
}

export class CodeInterpreter {
  static create(): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'mistral_code_interpreter',
      config: { type: 'code_interpreter' },
    });
  }
}

export class Connector {
  static create({ connectorId }: { connectorId: string }): llm.ProviderDefinedTool {
    return llm.tool({
      id: `mistral_connector_${connectorId}`,
      config: { type: 'connector', connector_id: connectorId },
    });
  }
}

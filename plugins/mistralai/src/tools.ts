// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';

export abstract class MistralTool extends llm.ProviderTool {
  abstract toJSON(): Record<string, unknown>;
}

export class WebSearch extends MistralTool {
  constructor() {
    super({ id: 'mistral_web_search' });
  }

  toJSON(): Record<string, unknown> {
    return { type: 'web_search' };
  }
}

export class DocumentLibrary extends MistralTool {
  readonly libraryIds: string[];

  constructor(libraryIds: string[]) {
    super({ id: 'mistral_document_library' });
    this.libraryIds = libraryIds;
  }

  toJSON(): Record<string, unknown> {
    return { type: 'document_library', libraryIds: this.libraryIds };
  }
}

export class CodeInterpreter extends MistralTool {
  constructor() {
    super({ id: 'mistral_code_interpreter' });
  }

  toJSON(): Record<string, unknown> {
    return { type: 'code_interpreter' };
  }
}

export class Connector extends MistralTool {
  readonly connectorId: string;

  constructor(connectorId: string) {
    super({ id: `mistral_connector_${connectorId}` });
    this.connectorId = connectorId;
  }

  toJSON(): Record<string, unknown> {
    return { type: 'connector', connectorId: this.connectorId };
  }
}

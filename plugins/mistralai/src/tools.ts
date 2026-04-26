// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Base class for Mistral provider tools (web search, document library, code interpreter). */
export abstract class MistralTool {
  abstract toDict(): Record<string, unknown>;
}

/** Enable web search tool to access up-to-date information from the internet. */
export class WebSearch extends MistralTool {
  toDict(): Record<string, unknown> {
    return { type: 'web_search' };
  }
}

/** Enable document library tool to search uploaded document collections. */
export class DocumentLibrary extends MistralTool {
  readonly libraryIds: string[];

  constructor(libraryIds: string[]) {
    super();
    this.libraryIds = libraryIds;
  }

  toDict(): Record<string, unknown> {
    return { type: 'document_library', libraryIds: this.libraryIds };
  }
}

/** Enable the code interpreter tool to write and execute Python code. */
export class CodeInterpreter extends MistralTool {
  toDict(): Record<string, unknown> {
    return { type: 'code_interpreter' };
  }
}

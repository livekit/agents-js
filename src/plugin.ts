// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export abstract class Plugin {
  registeredPlugins: Plugin[] = [];
  #title: string;
  #version: string;

  constructor(title: string, version: string) {
    this.#title = title;
    this.#version = version;
  }

  public static registerPlugins(plugin: Plugin) {
    plugin.registeredPlugins.push(plugin);
  }

  abstract downloadFiles(): void;

  get title(): string {
    return this.#title;
  }

  get version(): string {
    return this.#version;
  }
}

// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'events';

export enum PluginEventTypes {
  PluginRegistered = 'plugin_registered',
}

export type PluginEventMap = {
  [PluginEventTypes.PluginRegistered]: [Plugin];
};

export abstract class Plugin {
  static registeredPlugins = [] as Plugin[];
  static emitter = new EventEmitter<PluginEventMap>();

  #title: string;
  #version: string;
  #package: string;

  constructor(opts: { title: string; version: string; package: string }) {
    this.#title = opts.title;
    this.#version = opts.version;
    this.#package = opts.package;
  }

  static registerPlugin(plugin: Plugin) {
    Plugin.registeredPlugins.push(plugin);
    Plugin.emitter.emit(PluginEventTypes.PluginRegistered, plugin);
  }

  downloadFiles() {}

  get package(): string {
    return this.#package;
  }

  get title(): string {
    return this.#title;
  }

  get version(): string {
    return this.#version;
  }
}

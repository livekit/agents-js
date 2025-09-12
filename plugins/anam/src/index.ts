import { Plugin } from '@livekit/agents';
export * from './types.js';
export * from './api.js';
export * from './avatar.js';

class AnamPlugin extends Plugin {
  constructor() {
    super({
      title: 'anam',
      version: '0.0.1',
      package: '@livekit/agents-plugin-anam',
    });
  }
}
Plugin.registerPlugin(new AnamPlugin());
// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDownloadFailureMessage, runApp } from './cli.js';
import { Plugin } from './plugin.js';
import { ServerOptions } from './worker.js';

class FailingDownloadPlugin extends Plugin {
  constructor() {
    super({ title: 'failing-test-plugin', version: '0.0.0', package: 'test-plugin' });
  }

  async downloadFiles(): Promise<void> {
    throw new Error('download failed');
  }
}

describe('download-files CLI', () => {
  const originalArgv = process.argv;
  const originalPlugins = Plugin.registeredPlugins;

  afterEach(() => {
    process.argv = originalArgv;
    Plugin.registeredPlugins = originalPlugins;
    vi.restoreAllMocks();
  });

  it('exits non-zero when a plugin fails to download files', async () => {
    process.argv = ['node', 'test-agent.js', 'download-files'];
    Plugin.registeredPlugins = [new FailingDownloadPlugin()];

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    runApp(new ServerOptions({ agent: 'test-agent.js' }));

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  it('includes plugin details in download failure messages', () => {
    const message = formatDownloadFailureMessage([
      { plugin: new FailingDownloadPlugin(), error: new Error('download failed') },
    ]);

    expect(message).toContain('Failed to download files for 1 plugin');
    expect(message).toContain('failing-test-plugin');
    expect(message).toContain('test-plugin@0.0.0');
    expect(message).toContain('download failed');
  });
});

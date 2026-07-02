// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverPluginPackages, formatDownloadFailureMessage } from './download.js';
import { Plugin } from './plugin.js';

class StubPlugin extends Plugin {
  constructor(title: string, pkg: string, version: string) {
    super({ title, version, package: pkg });
  }
}

describe('discoverPluginPackages', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-discover-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const mkPkg = (root: string, name: string) => {
    const dir = path.join(root, 'node_modules', '@livekit', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: `@livekit/${name}`, version: '0.0.0' }),
    );
  };

  it('finds @livekit/agents-plugin-* packages in node_modules/@livekit/', () => {
    mkPkg(tmpDir, 'agents-plugin-foo');
    mkPkg(tmpDir, 'agents-plugin-bar');
    mkPkg(tmpDir, 'agents-plugin-baz');
    const result = discoverPluginPackages(tmpDir);
    const names = result.map((p) => p.name).sort();
    expect(names).toEqual([
      '@livekit/agents-plugin-bar',
      '@livekit/agents-plugin-baz',
      '@livekit/agents-plugin-foo',
    ]);
  });

  it('skips non-plugin @livekit packages', () => {
    mkPkg(tmpDir, 'agents-plugin-foo');
    mkPkg(tmpDir, 'agents');
    mkPkg(tmpDir, 'rtc-node');
    const result = discoverPluginPackages(tmpDir);
    expect(result.map((p) => p.name)).toEqual(['@livekit/agents-plugin-foo']);
  });

  it('skips the private test mock @livekit/agents-plugins-test', () => {
    mkPkg(tmpDir, 'agents-plugin-foo');
    mkPkg(tmpDir, 'agents-plugins-test');
    const result = discoverPluginPackages(tmpDir);
    expect(result.map((p) => p.name)).toEqual(['@livekit/agents-plugin-foo']);
  });

  it('dedupes plugins found in ancestor directories, keeping the closest match', () => {
    const nested = path.join(tmpDir, 'inner');
    fs.mkdirSync(nested, { recursive: true });
    mkPkg(tmpDir, 'agents-plugin-foo');
    mkPkg(nested, 'agents-plugin-foo');

    const result = discoverPluginPackages(nested);
    expect(result.length).toBe(1);
    expect(result[0]!.path.startsWith(path.resolve(nested))).toBe(true);
  });

  it('returns an empty list when no node_modules/@livekit exists anywhere upstream', () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-empty-'));
    try {
      const result = discoverPluginPackages(isolated);
      expect(result).toEqual([]);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe('formatDownloadFailureMessage', () => {
  it('formats a single failure with plugin metadata and error message', () => {
    const message = formatDownloadFailureMessage([
      {
        plugin: new StubPlugin('foo', '@livekit/agents-plugin-foo', '1.2.3'),
        error: new Error('boom'),
      },
    ]);
    expect(message).toContain('Failed to download files for 1 plugin');
    expect(message).toContain('foo (@livekit/agents-plugin-foo@1.2.3): boom');
  });

  it('pluralizes when more than one failure', () => {
    const message = formatDownloadFailureMessage([
      { plugin: new StubPlugin('a', 'pkg-a', '0.0.0'), error: new Error('x') },
      { plugin: new StubPlugin('b', 'pkg-b', '0.0.0'), error: 'string-error' },
    ]);
    expect(message).toContain('Failed to download files for 2 plugins');
    expect(message).toContain('a (pkg-a@0.0.0): x');
    expect(message).toContain('b (pkg-b@0.0.0): string-error');
  });
});

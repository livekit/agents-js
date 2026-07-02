// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
import { existsSync, rmSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadFileToCacheDir } from './hf_utils.js';

function getCachePath(repo: string, cacheDir?: string): string {
  const baseCacheDir = cacheDir || join(homedir(), '.cache', 'huggingface', 'hub');
  return join(baseCacheDir, `models--${repo.replace(/\//g, '--')}`);
}

function clearCache(repo: string, cacheDir?: string): void {
  const repoPath = getCachePath(repo, cacheDir);
  if (existsSync(repoPath)) {
    rmSync(repoPath, { recursive: true, force: true });
  }
}

describe('HuggingFace Download Fixed Implementation', () => {
  initializeLogger({ pretty: true, level: 'debug' });

  const TEST_REPO = 'livekit/turn-detector';
  const TEST_CACHE_DIR = join(process.cwd(), '.test-cache');

  beforeAll(() => {
    // Clear test cache before all tests
    clearCache(TEST_REPO, TEST_CACHE_DIR);
  });

  afterAll(() => {
    // Clean up test cache after all tests
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    }
  });

  describe('Basic Downloads', () => {
    it('should download a standard file in subdirectory', async () => {
      const result = await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'onnx/model_q8.onnx',
        revision: 'v1.2.2-en',
        cacheDir: TEST_CACHE_DIR,
      });

      expect(result).toBeTruthy();
      expect(existsSync(result)).toBe(true);

      const stats = statSync(result);
      const sizeMB = stats.size / 1024 / 1024;
      expect(sizeMB).toBeCloseTo(62.67, 1); // ~62.67 MB
    });

    it('should download a large file with retry logic', async () => {
      const result = await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'onnx/model.onnx',
        revision: 'v1.2.2-en',
        cacheDir: TEST_CACHE_DIR,
      });

      expect(result).toBeTruthy();
      expect(existsSync(result)).toBe(true);

      const stats = statSync(result);
      const sizeMB = stats.size / 1024 / 1024;
      expect(sizeMB).toBeCloseTo(249.96, 1); // ~250 MB
    });

    it('should download a very small file', async () => {
      const result = await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'languages.json',
        revision: 'v1.2.2-en',
        cacheDir: TEST_CACHE_DIR,
      });

      expect(result).toBeTruthy();
      expect(existsSync(result)).toBe(true);

      const stats = statSync(result);
      expect(stats.size).toBeLessThan(200); // Very small file (102 bytes)
    });

    it('should download from different revision', async () => {
      const result = await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'tokenizer.json',
        revision: 'v0.2.0-intl',
        cacheDir: TEST_CACHE_DIR,
      });

      expect(result).toBeTruthy();
      expect(existsSync(result)).toBe(true);

      const stats = statSync(result);
      const sizeMB = stats.size / 1024 / 1024;
      expect(sizeMB).toBeGreaterThan(3); // Should be around 3.36 MB or more
    });
  });

  describe('Cache Behavior', () => {
    it('should use cache on second download', async () => {
      // First download
      const firstPath = await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'onnx/model_q8.onnx',
        revision: 'v1.2.2-en',
        cacheDir: TEST_CACHE_DIR,
      });

      // Second download (should be from cache)
      const startTime = Date.now();
      const secondPath = await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'onnx/model_q8.onnx',
        revision: 'v1.2.2-en',
        cacheDir: TEST_CACHE_DIR,
      });
      const cacheTime = Date.now() - startTime;

      expect(secondPath).toBe(firstPath);
      expect(cacheTime).toBeLessThan(500); // Should be very fast if from cache
    });

    it('should respect localFileOnly flag when file is cached', async () => {
      // Ensure file is cached first
      await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'tokenizer.json',
        revision: 'v0.2.0-intl',
        cacheDir: TEST_CACHE_DIR,
      });

      // Now try with localFileOnly
      const cachedPath = await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'tokenizer.json',
        revision: 'v0.2.0-intl',
        cacheDir: TEST_CACHE_DIR,
        localFileOnly: true,
      });

      expect(cachedPath).toBeTruthy();
      expect(existsSync(cachedPath)).toBe(true);
    });

    it('should throw error with localFileOnly when file is not cached', async () => {
      await expect(
        downloadFileToCacheDir({
          repo: TEST_REPO,
          path: 'non-existent-file.txt',
          revision: 'main',
          cacheDir: TEST_CACHE_DIR,
          localFileOnly: true,
        }),
      ).rejects.toThrow(/File not found in cache/);
    });

    it('should save revision-to-commit mappings', async () => {
      await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'languages.json',
        revision: 'v1.2.2-en',
        cacheDir: TEST_CACHE_DIR,
      });

      // Check if refs file was created
      const refsPath = join(getCachePath(TEST_REPO, TEST_CACHE_DIR), 'refs', 'v1.2.2-en');
      expect(existsSync(refsPath)).toBe(true);
    });

    it('should handle multiple files from same revision without overwriting refs', async () => {
      // Download two different files from the same revision
      const file1Path = await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'onnx/model_q8.onnx',
        revision: 'v1.2.2-en',
        cacheDir: TEST_CACHE_DIR,
      });

      const file2Path = await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'languages.json',
        revision: 'v1.2.2-en',
        cacheDir: TEST_CACHE_DIR,
      });

      // Both files should exist
      expect(existsSync(file1Path)).toBe(true);
      expect(existsSync(file2Path)).toBe(true);

      // Now test that both files can be retrieved with localFileOnly
      const cachedFile1 = await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'onnx/model_q8.onnx',
        revision: 'v1.2.2-en',
        cacheDir: TEST_CACHE_DIR,
        localFileOnly: true,
      });

      const cachedFile2 = await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'languages.json',
        revision: 'v1.2.2-en',
        cacheDir: TEST_CACHE_DIR,
        localFileOnly: true,
      });

      // Both should be found in cache
      expect(cachedFile1).toBe(file1Path);
      expect(cachedFile2).toBe(file2Path);

      // Check that both files are in the same snapshot folder (same commit hash)
      // Extract commit hash from paths
      const match1 = file1Path.match(/snapshots\/([a-f0-9]{40})\//);
      const match2 = file2Path.match(/snapshots\/([a-f0-9]{40})\//);

      expect(match1).toBeTruthy();
      expect(match2).toBeTruthy();

      const commitHash1 = match1![1];
      const commitHash2 = match2![1];

      // FIXED: All files from the same revision should use the same HEAD commit
      expect(commitHash1).toBe(commitHash2);

      // Check that the refs file contains the single HEAD commit
      const { readFileSync } = await import('fs');
      const refsPath = join(getCachePath(TEST_REPO, TEST_CACHE_DIR), 'refs', 'v1.2.2-en');
      const refsContent = readFileSync(refsPath, 'utf-8').trim();

      // The refs file should contain just the commit hash, not a JSON mapping
      expect(refsContent).toMatch(/^[a-f0-9]{40}$/);
      expect(refsContent).toBe(commitHash1);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid repository gracefully', async () => {
      await expect(
        downloadFileToCacheDir({
          repo: 'non-existent-org/non-existent-repo',
          path: 'file.txt',
          revision: 'main',
          cacheDir: TEST_CACHE_DIR,
        }),
      ).rejects.toThrow();
    });

    it('should handle invalid file path gracefully', async () => {
      await expect(
        downloadFileToCacheDir({
          repo: TEST_REPO,
          path: 'non-existent-file-path.xyz',
          revision: 'v1.2.2-en',
          cacheDir: TEST_CACHE_DIR,
        }),
      ).rejects.toThrow();
    });

    it('should handle invalid revision gracefully', async () => {
      await expect(
        downloadFileToCacheDir({
          repo: TEST_REPO,
          path: 'tokenizer.json',
          revision: 'non-existent-revision',
          cacheDir: TEST_CACHE_DIR,
        }),
      ).rejects.toThrow();
    });
  });

  describe('Cache Structure', () => {
    it('should create proper cache directory structure', async () => {
      await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'onnx/model_q8.onnx',
        revision: 'v1.2.2-en',
        cacheDir: TEST_CACHE_DIR,
      });

      const cachePath = getCachePath(TEST_REPO, TEST_CACHE_DIR);

      // Check expected directories exist
      expect(existsSync(join(cachePath, 'blobs'))).toBe(true);
      expect(existsSync(join(cachePath, 'snapshots'))).toBe(true);
      expect(existsSync(join(cachePath, 'refs'))).toBe(true);
    });

    it('should handle commit hash revisions', async () => {
      // We'll use the actual commit hash from the v1.2.2-en tag
      // First, download to ensure we have the commit hash mapping
      const tagResult = await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'onnx/model_q8.onnx',
        revision: 'v1.2.2-en',
        cacheDir: TEST_CACHE_DIR,
      });

      // Extract the commit hash from the path
      const match = tagResult.match(/snapshots\/([a-f0-9]{40})\//);
      expect(match).toBeTruthy();
      const commitHash = match![1];

      // Now download with commit hash directly
      const result = await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'onnx/model_q8.onnx',
        revision: commitHash,
        cacheDir: TEST_CACHE_DIR,
      });

      expect(result).toBeTruthy();
      expect(result).toContain(commitHash);
    });

    it('should store files as content-addressed blobs', async () => {
      await downloadFileToCacheDir({
        repo: TEST_REPO,
        path: 'languages.json',
        revision: 'v1.2.2-en',
        cacheDir: TEST_CACHE_DIR,
      });

      const blobsPath = join(getCachePath(TEST_REPO, TEST_CACHE_DIR), 'blobs');
      const { readdirSync } = await import('fs');
      const blobs = readdirSync(blobsPath);

      // Should have at least one blob with SHA256 hash name
      expect(blobs.length).toBeGreaterThan(0);
      expect(blobs[0]).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('Performance', () => {
    it('should download files in parallel efficiently', async () => {
      const startTime = Date.now();

      // Download multiple files in parallel
      const promises = [
        downloadFileToCacheDir({
          repo: TEST_REPO,
          path: 'onnx/model_q8.onnx',
          revision: 'v1.2.2-en',
          cacheDir: TEST_CACHE_DIR,
        }),
        downloadFileToCacheDir({
          repo: TEST_REPO,
          path: 'languages.json',
          revision: 'v1.2.2-en',
          cacheDir: TEST_CACHE_DIR,
        }),
        downloadFileToCacheDir({
          repo: TEST_REPO,
          path: 'tokenizer.json',
          revision: 'v0.2.0-intl',
          cacheDir: TEST_CACHE_DIR,
        }),
      ];

      const results = await Promise.all(promises);
      const totalTime = Date.now() - startTime;

      // All should succeed
      results.forEach((result) => {
        expect(result).toBeTruthy();
        expect(existsSync(result)).toBe(true);
      });

      // Should be faster than downloading sequentially
      console.log(`Parallel download took ${totalTime}ms`);
    });
  });

  describe('Failures', () => {
    it('should handle non-existent file', async () => {
      await expect(
        downloadFileToCacheDir({
          repo: TEST_REPO,
          path: 'onnx/model_non_existent.onnx',
          revision: 'v1.2.2-en',
          cacheDir: TEST_CACHE_DIR,
        }),
      ).rejects.toThrow('cannot get path info for onnx/model_non_existent.onnx');
    });
  });
});

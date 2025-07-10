// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Fixed version of HuggingFace's downloadFileToCacheDir
 *
 * This implementation fixes issues with:
 * - Files in subdirectories
 * - Very small files
 * - Large files
 *
 * The main change is in how we handle the downloadFile response
 * and add proper error handling with retries.
 */
import type { CommitInfo, PathInfo, RepoDesignation } from '@huggingface/hub';
import { downloadFile, pathsInfo } from '@huggingface/hub';
import { log } from '@livekit/agents';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';

// Define CredentialsParams if not exported
interface CredentialsParams {
  accessToken?: string;
}

export const REGEX_COMMIT_HASH: RegExp = new RegExp('^[0-9a-f]{40}$');

// Helper functions from HuggingFace's cache-management
function getHFHubCachePath(customCacheDir?: string): string {
  return customCacheDir || join(homedir(), '.cache', 'huggingface', 'hub');
}

function getRepoFolderName(repoId: string): string {
  return `models--${repoId.replace(/\//g, '--')}`;
}

function toRepoId(repo: RepoDesignation | string): string {
  if (typeof repo === 'string') {
    return repo;
  }
  return `${repo.name}`;
}

/**
 * Create a symbolic link following HuggingFace's implementation
 * Based on: https://github.com/huggingface/huggingface_hub
 *
 * Creates relative symlinks for better portability, with fallback to copying
 * on systems that don't support symlinks (e.g., Windows without admin rights).
 */
async function createSymlink(sourcePath: string, targetPath: string): Promise<void> {
  const logger = log();
  const { symlink, rm, copyFile } = await import('node:fs/promises');

  // Expand ~ to home directory
  function expandUser(path: string): string {
    if (path.startsWith('~')) {
      return path.replace('~', homedir());
    }
    return path;
  }

  const absSrc = resolve(expandUser(sourcePath));
  const absDst = resolve(expandUser(targetPath));

  // Remove existing file/symlink if it exists
  try {
    await rm(absDst);
  } catch {
    // Ignore - file might not exist
  }

  try {
    // Create relative symlink (better for portability)
    const relativePath = relative(dirname(absDst), absSrc);
    await symlink(relativePath, absDst);
    logger.debug({ source: absSrc, target: absDst, relative: relativePath }, 'Created symlink');
  } catch (symlinkError) {
    // Symlink failed (common on Windows without admin rights)
    // Fall back to copying the file
    logger.warn({ source: absSrc, target: absDst }, 'Symlink not supported, falling back to copy');
    try {
      await copyFile(absSrc, absDst);
      logger.debug({ source: absSrc, target: absDst }, 'File copied successfully');
    } catch (copyError) {
      logger.error(
        { error: (copyError as Error).message, source: absSrc, target: absDst },
        'Failed to copy file',
      );
      // If copy also fails, throw the original symlink error
      throw symlinkError;
    }
  }
}

function getFilePointer(storageFolder: string, revision: string, relativeFilename: string): string {
  const snapshotPath = join(storageFolder, 'snapshots');
  return join(snapshotPath, revision, relativeFilename);
}

/**
 * handy method to check if a file exists, or the pointer of a symlinks exists
 * @param path
 * @param followSymlinks
 */
async function exists(path: string, followSymlinks?: boolean): Promise<boolean> {
  try {
    if (followSymlinks) {
      await stat(path);
    } else {
      await lstat(path);
    }
    return true;
  } catch (err: unknown) {
    return false;
  }
}

/**
 * Enhanced download with retry logic for edge cases
 */
async function downloadFileWithRetry(
  params: Parameters<typeof downloadFile>[0],
  maxRetries = 3,
): Promise<Blob | null> {
  const logger = log();
  let lastError: Error | null = null;
  const { repo, path, revision = 'main' } = params;
  const repoId = typeof repo === 'string' ? repo : repo.name;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      logger.debug(
        { attempt: attempt + 1, maxRetries, repoId, path, revision },
        'Attempting to download file',
      );
      const blob = await downloadFile(params);

      // Check if we got a valid response
      if (blob && blob.size > 0) {
        logger.info({ size: blob.size, repoId, path }, 'Successfully downloaded file via HF API');
        return blob;
      }

      // If blob is null or empty, try direct URL download
      const url = `https://huggingface.co/${repoId}/resolve/${revision}/${path}`;
      logger.warn(
        { repoId, path, revision },
        'HF API returned invalid response, falling back to direct URL download',
      );

      const headers: Record<string, string> = {};
      if (params.accessToken) {
        headers['Authorization'] = `Bearer ${params.accessToken}`;
      }

      const response = await fetch(url, { headers });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const directBlob = await response.blob();
      logger.info({ size: directBlob.size, url }, 'Successfully downloaded file via direct URL');
      return directBlob;
    } catch (error) {
      lastError = error as Error;
      logger.error(
        { error: lastError.message, attempt: attempt + 1, repoId, path },
        'Download attempt failed',
      );
      if (attempt < maxRetries - 1) {
        const waitTime = 1000 * (attempt + 1);
        logger.debug({ waitTime }, 'Waiting before retry');
        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
  }

  logger.error(
    { error: lastError?.message, repoId, path },
    'Failed to download file after all retries',
  );
  throw lastError || new Error('Failed to download file after retries');
}

/**
 * Download a given file if it's not already present in the local cache.
 * @param params
 * @return the symlink to the blob object
 */
export async function downloadFileToCacheDir(
  params: {
    repo: RepoDesignation;
    path: string;
    /**
     * If true, will download the raw git file.
     *
     * For example, when calling on a file stored with Git LFS, the pointer file will be downloaded instead.
     */
    raw?: boolean;
    /**
     * An optional Git revision id which can be a branch name, a tag, or a commit hash.
     *
     * @default "main"
     */
    revision?: string;
    hubUrl?: string;
    cacheDir?: string;
    /**
     * Custom fetch function to use instead of the default one, for example to use a proxy or edit headers.
     */
    fetch?: typeof fetch;
    /**
     * If true, only return cached files, don't download
     */
    localFileOnly?: boolean;
  } & Partial<CredentialsParams>,
): Promise<string> {
  const logger = log();

  // get revision provided or default to main
  const revision = params.revision ?? 'main';
  const cacheDir = params.cacheDir ?? getHFHubCachePath();
  // get repo id
  const repoId = toRepoId(params.repo);
  // get storage folder
  const storageFolder = join(cacheDir, getRepoFolderName(repoId));

  logger.debug(
    { repoId, path: params.path, revision, cacheDir },
    'Starting file download/cache check',
  );

  let commitHash: string | undefined;

  // if user provides a commitHash as revision, and they already have the file on disk, shortcut everything.
  if (REGEX_COMMIT_HASH.test(revision)) {
    commitHash = revision;
    const pointerPath = getFilePointer(storageFolder, revision, params.path);
    if (await exists(pointerPath, true)) {
      logger.info({ pointerPath, commitHash }, 'File found in cache (commit hash)');
      return pointerPath;
    }
  }

  // If localFileOnly, check cache without making API calls
  if (params.localFileOnly) {
    logger.debug({ repoId, path: params.path, revision }, 'Local file only mode - checking cache');

    // Check with revision as-is
    const directPath = getFilePointer(storageFolder, revision, params.path);
    if (await exists(directPath, true)) {
      logger.info({ directPath }, 'File found in cache (direct path)');
      return directPath;
    }

    // If revision is not a commit hash, try to resolve from refs
    if (!REGEX_COMMIT_HASH.test(revision)) {
      const refsPath = join(storageFolder, 'refs', revision);
      try {
        const { readFileSync } = await import('fs');
        const resolvedHash = readFileSync(refsPath, 'utf-8').trim();
        logger.debug({ revision, resolvedHash }, 'Resolved revision to commit hash from refs');
        const resolvedPath = getFilePointer(storageFolder, resolvedHash, params.path);
        if (await exists(resolvedPath, true)) {
          logger.info({ resolvedPath, resolvedHash }, 'File found in cache (via refs)');
          return resolvedPath;
        }
      } catch {
        logger.debug({ revision }, 'No ref mapping found for revision');
        // Ref doesn't exist
      }
    }

    const error = `File not found in cache: ${repoId}/${params.path} (revision: ${revision})`;
    logger.error({ repoId, path: params.path, revision }, error);
    throw new Error(error);
  }

  logger.debug({ repoId, path: params.path, revision }, 'Fetching path info from HF API');
  const pathsInformation: (PathInfo & { lastCommit: CommitInfo })[] = await pathsInfo({
    ...params,
    paths: [params.path],
    revision: revision,
    expand: true,
  });
  if (!pathsInformation || pathsInformation.length !== 1) {
    const error = `cannot get path info for ${params.path}`;
    logger.error({ repoId, path: params.path, pathsInfoLength: pathsInformation?.length }, error);
    throw new Error(error);
  }

  const pathInfo = pathsInformation[0];
  if (!pathInfo) {
    const error = `No path info returned for ${params.path}`;
    logger.error({ repoId, path: params.path }, error);
    throw new Error(error);
  }

  let etag: string;
  if (pathInfo.lfs) {
    etag = pathInfo.lfs.oid; // get the LFS pointed file oid
    logger.debug({ etag, path: params.path }, 'File is LFS pointer');
  } else {
    etag = pathInfo.oid; // get the repo file if not a LFS pointer
    logger.debug({ etag, path: params.path }, 'File is regular git object');
  }

  const actualCommitHash = commitHash ?? pathInfo.lastCommit.id;
  const pointerPath = getFilePointer(storageFolder, actualCommitHash, params.path);
  const blobPath = join(storageFolder, 'blobs', etag);

  logger.debug({ actualCommitHash, pointerPath, blobPath }, 'Computed cache paths');

  // if we have the pointer file, we can shortcut the download
  if (await exists(pointerPath, true)) {
    logger.info({ pointerPath, actualCommitHash }, 'File found in cache (pointer exists)');
    return pointerPath;
  }

  // mkdir blob and pointer path parent directory
  await mkdir(dirname(blobPath), { recursive: true });
  await mkdir(dirname(pointerPath), { recursive: true });

  // We might already have the blob but not the pointer
  // shortcut the download if needed
  if (await exists(blobPath)) {
    logger.info({ blobPath, etag }, 'Blob already exists in cache, creating symlink only');
    // create symlinks in snapshot folder to blob object
    await createSymlink(blobPath, pointerPath);
    return pointerPath;
  }

  const incomplete = `${blobPath}.incomplete`;
  logger.info({ path: params.path, incomplete }, 'Starting file download');

  // Use enhanced download with retry
  const blob: Blob | null = await downloadFileWithRetry({
    ...params,
    revision: actualCommitHash,
  });

  if (!blob) {
    const error = `invalid response for file ${params.path}`;
    logger.error({ path: params.path }, error);
    throw new Error(error);
  }

  logger.debug({ size: blob.size }, 'Writing blob to disk');
  await pipeline(Readable.fromWeb(blob.stream() as ReadableStream), createWriteStream(incomplete));

  // rename .incomplete file to expected blob
  await rename(incomplete, blobPath);
  logger.debug({ blobPath }, 'Renamed incomplete file to final blob');

  // create symlinks in snapshot folder to blob object
  await createSymlink(blobPath, pointerPath);
  logger.debug({ blobPath, pointerPath }, 'Created symlink from snapshot to blob');

  // Save revision mapping if needed
  if (!REGEX_COMMIT_HASH.test(revision) && revision !== actualCommitHash) {
    const refsPath = join(storageFolder, 'refs');
    await mkdir(refsPath, { recursive: true });
    const { writeFileSync } = await import('fs');
    writeFileSync(join(refsPath, revision), actualCommitHash);
    logger.info({ revision, actualCommitHash }, 'Saved revision to commit hash mapping');
  }

  logger.info({ pointerPath, size: blob.size }, 'File download completed successfully');
  return pointerPath;
}

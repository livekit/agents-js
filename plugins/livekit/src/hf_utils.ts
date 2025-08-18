// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Fixed version of HuggingFace's downloadFileToCacheDir that matches Python's behavior
 *
 * Key fix: Uses branch/tag HEAD commit for snapshot paths, not file's last commit
 * This ensures all files from the same revision end up in the same snapshot folder
 */
import type { CommitInfo, PathInfo, RepoDesignation } from '@huggingface/hub';
import { downloadFile, listCommits, pathsInfo } from '@huggingface/hub';
import { log } from '@livekit/agents';
import { createWriteStream, writeFileSync } from 'node:fs';
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
 * Get the HEAD commit hash for a branch/tag (matching Python's behavior)
 */
async function getBranchHeadCommit(
  repo: RepoDesignation,
  revision: string,
  params: { accessToken?: string; hubUrl?: string; fetch?: typeof fetch },
): Promise<string | null> {
  const logger = log();

  try {
    // If already a commit hash, return it
    if (REGEX_COMMIT_HASH.test(revision)) {
      return revision;
    }

    // Get the first commit from listCommits - this is the HEAD
    for await (const commit of listCommits({
      repo,
      revision,
      ...params,
    })) {
      // The commit object structure varies, so we check multiple possible properties
      const commitHash = (commit as any).oid || (commit as any).id || (commit as any).commitId;
      if (commitHash) {
        return commitHash;
      }
      break; // Only need the first one
    }

    logger.error({ repo: toRepoId(repo), revision }, 'No commits found for revision');
    return null;
  } catch (error) {
    logger.error(
      { error: (error as Error).message, repo: toRepoId(repo), revision },
      'Error getting HEAD commit',
    );
    throw error;
  }
}

/**
 * Create a symbolic link following HuggingFace's implementation
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

async function saveRevisionMapping({
  storageFolder,
  revision,
  commitHash,
}: {
  storageFolder: string;
  revision: string;
  commitHash: string;
}): Promise<void> {
  if (!REGEX_COMMIT_HASH.test(revision) && revision !== commitHash) {
    const refsPath = join(storageFolder, 'refs');
    await mkdir(refsPath, { recursive: true });
    writeFileSync(join(refsPath, revision), commitHash);
  }
}

/**
 * Download a given file if it's not already present in the local cache.
 * Matches Python's hf_hub_download behavior by using branch HEAD commits.
 */
export async function downloadFileToCacheDir(
  params: {
    repo: RepoDesignation;
    path: string;
    /**
     * If true, will download the raw git file.
     */
    raw?: boolean;
    /**
     * An optional Git revision id which can be a branch name, a tag, or a commit hash.
     * @default "main"
     */
    revision?: string;
    hubUrl?: string;
    cacheDir?: string;
    /**
     * Custom fetch function to use instead of the default one
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

  let branchHeadCommit: string | undefined;

  // if user provides a commitHash as revision, use it directly
  if (REGEX_COMMIT_HASH.test(revision)) {
    branchHeadCommit = revision;
    const pointerPath = getFilePointer(storageFolder, revision, params.path);
    if (await exists(pointerPath, true)) {
      logger.debug(
        { pointerPath, commitHash: branchHeadCommit },
        'File found in cache (commit hash)',
      );
      return pointerPath;
    }
  }

  // If localFileOnly, check cache without making API calls
  if (params.localFileOnly) {
    logger.debug({ repoId, path: params.path, revision }, 'Local file only mode - checking cache');

    // Check with revision as-is (in case it's a commit hash)
    const directPath = getFilePointer(storageFolder, revision, params.path);
    if (await exists(directPath, true)) {
      logger.debug({ directPath }, 'File found in cache (direct path)');
      return directPath;
    }

    // If revision is not a commit hash, try to resolve from refs
    if (!REGEX_COMMIT_HASH.test(revision)) {
      const refsPath = join(storageFolder, 'refs', revision);
      try {
        const { readFileSync } = await import('fs');
        const resolvedHash = readFileSync(refsPath, 'utf-8').trim();
        const resolvedPath = getFilePointer(storageFolder, resolvedHash, params.path);
        if (await exists(resolvedPath, true)) {
          logger.debug({ resolvedPath, resolvedHash }, 'File found in cache (via refs)');
          return resolvedPath;
        }
      } catch {
        logger.debug({ revision }, 'No ref mapping found for revision');
      }
    }

    const error = `File not found in cache: ${repoId}/${params.path} (revision: ${revision}). Make sure to run the download-files command before running the agent worker.`;
    logger.error({ repoId, path: params.path, revision }, error);
    throw new Error(error);
  }

  // Get the branch HEAD commit if not already a commit hash
  if (!branchHeadCommit) {
    const headCommit = await getBranchHeadCommit(params.repo, revision, params);
    if (!headCommit) {
      throw new Error(`Failed to resolve revision ${revision} to commit hash`);
    }
    branchHeadCommit = headCommit;
  }

  // Check if file exists with the branch HEAD commit
  const pointerPath = getFilePointer(storageFolder, branchHeadCommit, params.path);
  if (await exists(pointerPath, true)) {
    logger.debug({ pointerPath, branchHeadCommit }, 'File found in cache (branch HEAD)');

    await saveRevisionMapping({
      storageFolder,
      revision,
      commitHash: branchHeadCommit,
    });

    return pointerPath;
  }

  // Now get file metadata to download it
  logger.debug(
    { repoId, path: params.path, revision: branchHeadCommit },
    'Fetching path info from HF API',
  );
  const pathsInformation: (PathInfo & { lastCommit: CommitInfo })[] = await pathsInfo({
    ...params,
    paths: [params.path],
    revision: branchHeadCommit, // Use HEAD commit for consistency
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

  const blobPath = join(storageFolder, 'blobs', etag);

  logger.debug({ branchHeadCommit, pointerPath, blobPath }, 'Computed cache paths');

  // mkdir blob and pointer path parent directory
  await mkdir(dirname(blobPath), { recursive: true });
  await mkdir(dirname(pointerPath), { recursive: true });

  // We might already have the blob but not the pointer
  // shortcut the download if needed
  if (await exists(blobPath)) {
    logger.debug({ blobPath, etag }, 'Blob already exists in cache, creating symlink only');
    // create symlinks in snapshot folder to blob object
    await createSymlink(blobPath, pointerPath);
    return pointerPath;
  }

  const incomplete = `${blobPath}.incomplete`;
  logger.debug({ path: params.path, incomplete }, 'Starting file download');

  // Use enhanced download with retry - use branch HEAD commit for download
  const blob: Blob | null = await downloadFile({
    ...params,
    revision: branchHeadCommit,
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

  await saveRevisionMapping({
    storageFolder,
    revision,
    commitHash: branchHeadCommit,
  });

  logger.debug({ pointerPath, size: blob.size }, 'File download completed successfully');
  return pointerPath;
}

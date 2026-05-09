#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setDefaultAgentPath } from './context.js';

const USAGE = 'Usage: lk-agent <entry> <command> [...args]';

export type PreparedBootstrap = {
  agentPath: string;
  argv: string[];
};

export function prepareBootstrap(argv: string[], cwd = process.cwd()): PreparedBootstrap {
  const [nodePath = process.execPath, , entry, ...commandArgs] = argv;
  if (!entry || commandArgs.length === 0) {
    throw new Error(USAGE);
  }

  const agentPath = resolve(cwd, entry);
  return {
    agentPath,
    argv: [nodePath, agentPath, ...commandArgs],
  };
}

export async function validateAgentEntryFile(agentPath: string) {
  let entryStat;
  try {
    entryStat = await stat(agentPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Agent entry file does not exist: ${agentPath}`);
    }
    throw error;
  }

  if (!entryStat.isFile()) {
    throw new Error(`Agent entry path is not a file: ${agentPath}`);
  }
}

export async function bootstrap(argv = process.argv, cwd = process.cwd()) {
  const prepared = prepareBootstrap(argv, cwd);
  await validateAgentEntryFile(prepared.agentPath);
  setDefaultAgentPath(prepared.agentPath);
  process.argv = prepared.argv;
  const importUrl = pathToFileURL(prepared.agentPath).href;
  await import(importUrl);
}

function isCliInvocation() {
  const invoked = process.argv[1];
  if (!invoked) {
    return false;
  }

  const invokedName = basename(invoked);
  return invokedName === 'lk-agent' || invokedName === 'bin.js';
}

if (isCliInvocation()) {
  bootstrap().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

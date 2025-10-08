// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log as agentsLog } from '@livekit/agents';
import type { Logger } from 'pino';

export const log = (): Logger => agentsLog().child({ plugin: 'bey' });

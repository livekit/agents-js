// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log as agentsLog } from '@livekit/agents';

export const log = (): ReturnType<typeof agentsLog> => agentsLog().child({ plugin: 'meta' });

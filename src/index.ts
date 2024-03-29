// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { version } from '../package.json';
import { VAD, VADEventType, VADStream } from './vad';
import { Plugin } from './plugin';

module.exports = {
  version,
  VAD,
  VADEventType,
  VADStream,
  Plugin,
};

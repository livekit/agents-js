#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { main } from '../download.js';

main().then((code) => {
  process.exit(code);
});

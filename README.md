<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Agents Framework for NodeJS

This is a Node port of the [LiveKit Agents framework](https://livekit.io/agents), originally written in Python.

## Usage

The wiki includes a [guide](https://github.com/livekit/agents-js/wiki/Getting-started) on setting up Node Agents and writing a small program using the framework.

## Building

This project depends on [`@livekit/rtc-node`](https://npmjs.com/package/@livekit/rtc-node), which itself depends on `libstdc++` version 6 being in PATH.

Install the project dependencies and run the build script:
```sh
$ pnpm install
$ cd agents
$ pnpm build
```

Your output will be in the `dist/` directory.

## License
This project is licensed under `Apache-2.0`, and is [REUSE-3.0](https://reuse.software) compliant. Refer to [the license](LICENSES/Apache-2.0.txt) for details.

<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Agents Framework for NodeJS

This is a Node port of the [LiveKit Agents framework](https://livekit.io/agents), originally written in Python.

## Development
This project builds to Node-compatible JavaScript, but is developed using the faster [Bun](https://bun.sh) JavaScript runtime. As a superset of Node, there are some caveats:

- Bun uses `package.json#workspaces` for monorepo handling, while pnpm uses `pnpm-workspace.yaml`. Using pnpm will therefore generate a new `node_modules/` for every subpackage.
- Running the `build` script invokes the [considerably faster](https://github-production-user-asset-6210df.s3.amazonaws.com/3084745/266451348-e65fa63c-99c7-4bcf-950b-e2fe9408a942.png) `Bun.build` bundler, as opposed to running `tsc`.
- Other incompatibilities which may be added to the project at any time

For this reason, while it should be possible to use npm, yarn, or pnpm with minor modifications to the builder, it is advised to install Bun.

## Building

This project depends on [`@livekit/rtc-node`](https://npmjs.com/package/@livekit/rtc-node), which itself depends on `libstdc++` version 6 being in PATH.

Install the project dependencies and run the build script:
```sh
$ bun install
$ cd agents
$ bun run build
```

Your output will be in the `dist/` directory.

## License
This project is licensed under `Apache-2.0`, and is [REUSE-3.0](https://reuse.software) compliant. Refer to [the license](LICENSES/Apache-2.0.txt) for details.

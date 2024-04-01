<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.
SPDX-FileCopyrightText: 2024 aoife cassidy <aoife@cassidy.sh>

SPDX-License-Identifier: Apache-2.0
-->

# aikit-js

This is a Node port of the [LiveKit Agents framework](https://livekit.io/agents), originally written in Python.

## Development
This project builds to Node-compatible JavaScript, but is developed using the faster [Bun](https://bun.sh) JavaScript runtime. As a superset of Node, there are some caveats:

- Bun uses `package.json#workspaces` for monorepo handling, while pnpm uses `pnpm-workspace.yaml`. Using pnpm will therefore generate a new `node_modules/` for every subpackage.
- Running the `build` script invokes the [considerably faster](https://bun.sh/images/bundler-speed.png) `Bun.build` bundler, as opposed to running `tsc`.
- Other incompatibilities which may be added to the project at any time

For this reason, while it should be possible to use npm, yarn, or pnpm with minor modifications to the builder, it is advised to install Bun.

## Building

This project depends on an as-yet-unreleased version of `@livekit/rtc-node`. Thankfully, Bun allows us to easily link to local repositories:

```sh
~$ cd ~/src/node-sdks-temp/rtc-node
rtc-node$ bun link
Success! Registered "@livekit/rtc-node"

rtc-node$ cd ~/src/aikit-js
aikit-js$ bun link @livekit/rtc-node
```

This will not add the package to `package.json`, however it will be imported and ready to use. Now you can build the project:

```sh
$ cd agents && bun run build
```

Your output will be in the `dist/` directory.

## License
This project is licensed under `Apache-2.0`, and is [REUSE-3.0](https://reuse.software) compliant. Refer to [the license](LICENSES/Apache-2.0.txt) for details.

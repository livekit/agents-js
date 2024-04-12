// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { runApp } from '../agents/src/cli'
import { JobContext, JobRequest, WorkerOptions } from '../agents/src'

const requestFunc = async (req: JobRequest) => {
  console.log('received request', req)
  await req.accept(async (_: JobContext) => {
    console.log('starting voice assistant...')

    // etc
  })
}

runApp(new WorkerOptions({ requestFunc }))

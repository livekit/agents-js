import { pathToFileURL } from "url";
import { IPCMessage } from "./message.js";
import EventEmitter, { once } from "node:events";
import { initializeLogger, log } from "../log.js";
import { InferenceRunner } from "../inference_runner.js";

const ORPHANED_TIMEOUT = 15 * 1000;

(async () => {
  if (process.send) {
    // don't do anything on C-c
    // this is handled in cli, triggering a termination of all child processes at once.
    process.on('SIGINT', () => { });

    const runners: { [id: string]: InferenceRunner } = await Promise.all(Object.entries(JSON.parse(process.argv[2]!)).map(async ([k, v]) => {
      return [k, await import(pathToFileURL(v as string).pathname).then((m) => m.default)];
    })).then(Object.fromEntries)

    await once(process, 'message').then(([msg]: IPCMessage[]) => {
      msg = msg!;
      if (msg.case !== 'initializeRequest') {
        throw new Error('first message must be InitializeRequest');
      }
      initializeLogger(msg.value.loggerOptions);
    });
    let logger = log().child({ pid: process.pid })

    await Promise.all(Object.entries(runners).map(async ([runner, v]) => {
      logger.child({ runner }).debug("initializing inference runner");
      await v.initialize();
    }))
    logger.debug("all inference runners initialized");
    process.send({ case: 'initializeResponse' });

    const closeEvent = new EventEmitter();

    const orphanedTimeout = setTimeout(() => {
      logger.warn('process orphaned, shutting down');
      process.exit();
    }, ORPHANED_TIMEOUT);


    const handleInferenceRequest = async ({ method, requestId, data }: { method: string; requestId: string; data: unknown }) => {
      if (!runners[method]) {
        logger.child({ method }).warn("unknown inference method");
      }

      try {
        const resp = runners[method]!.run(data)
        process.send!({ case: "inferenceResponse", value: { requestId, data: resp } })
      } catch (error) {
        process.send!({ case: 'inferenceResponse', value: { requestId, error } })
      }
    }

    process.on('message', (msg: IPCMessage) => {
      switch (msg.case) {
        case "pingRequest":
          orphanedTimeout.refresh()
          process.send!({
            case: 'pongResponse',
            value: { lastTimestamp: msg.value.timestamp, timestamp: Date.now() },
          })
          break;
        case "shutdownRequest":
          closeEvent.emit('close');
          break;
        case "inferenceRequest":
          handleInferenceRequest(msg.value);
      }
    })
  }
})()

import { pino } from 'pino';
/** @internal */
export let loggerOptions;
/** @internal */
let logger = undefined;
/** @internal */
export const log = () => {
    if (!logger) {
        throw new TypeError('logger not initialized. did you forget to run initializeLogger()?');
    }
    return logger;
};
/** @internal */
export const initializeLogger = ({ pretty, level }) => {
    loggerOptions = { pretty, level };
    logger = pino(pretty
        ? {
            transport: {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                },
            },
        }
        : {});
    if (level) {
        logger.level = level;
    }
};
//# sourceMappingURL=log.js.map
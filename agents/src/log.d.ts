import type { Logger } from 'pino';

/** @internal */
export type LoggerOptions = {
  pretty: boolean;
  level?: string;
};
/** @internal */
export declare let loggerOptions: LoggerOptions;
/** @internal */
export declare const log: () => Logger;
/** @internal */
export declare const initializeLogger: ({ pretty, level }: LoggerOptions) => void;
//# sourceMappingURL=log.d.ts.map

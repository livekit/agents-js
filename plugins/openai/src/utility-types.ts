export type ExtractStrict<T, U extends T> = T extends U ? T : never;

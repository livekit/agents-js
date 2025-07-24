export interface APIConnectOptions {
  maxRetry: number;
  retryIntervalMs: number;
  timeoutMs: number;
}

export const DEFAULT_API_CONNECT_OPTIONS: APIConnectOptions = {
  maxRetry: 3,
  retryIntervalMs: 2000,
  timeoutMs: 10000,
};

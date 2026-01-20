import { ofetch } from 'ofetch';

export interface PostOptions {
  baseUrl: string;
  token: string;
  signal?: AbortSignal;
  timeout?: number;
}

export interface PredictOptions {
  threshold: number;
  minFrames: number;
}

export interface PredictEndpointResponse {
  created_at: number;
  is_bargein: boolean;
  probabilities: number[];
}

export interface PredictResponse {
  createdAt: number;
  isBargein: boolean;
  probabilities: number[];
  predictionDuration: number;
}

export async function predictHTTP(
  data: Int16Array,
  predictOptions: PredictOptions,
  options: PostOptions,
): Promise<PredictResponse> {
  const createdAt = performance.now();
  const url = new URL(`/bargein`, options.baseUrl);
  url.searchParams.append('threshold', predictOptions.threshold.toString());
  url.searchParams.append('min_frames', predictOptions.minFrames.toFixed());
  url.searchParams.append('created_at', createdAt.toFixed());

  const { created_at, is_bargein, probabilities } = await ofetch<PredictEndpointResponse>(
    url.toString(),
    {
      retry: 1,
      retryDelay: 100,
      headers: {
        'Content-Type': 'application/octet-stream',
        Authorization: `Bearer ${options.token}`,
      },
      signal: options.signal,
      timeout: options.timeout,
      method: 'POST',
      body: data,
    },
  );

  return {
    createdAt: created_at,
    isBargein: is_bargein,
    probabilities,
    predictionDuration: (performance.now() - createdAt) / 1e9,
  };
}

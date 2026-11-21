export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bytes?: Uint8Array;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpClient {
  request(input: HttpRequest): Promise<HttpResponse>;
}

export function createFetchClient(timeoutMs = 30_000): HttpClient {
  return {
    async request(input) {
      const response = await fetch(input.url, {
        method: input.method ?? "GET",
        headers: input.headers,
        body: input.bytes ? Buffer.from(input.bytes) : input.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: response.status, headers, body: await response.text() };
    },
  };
}

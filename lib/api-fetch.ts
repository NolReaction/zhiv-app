/** API transport is selected by the entry point; web keeps its normal cookie fetch. */
export type ApiTransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let transport: ApiTransport | null = null;

export function installApiTransport(value: ApiTransport): () => void {
  transport = value;
  return () => { if (transport === value) transport = null; };
}

export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return transport ? transport(input, init) : fetch(input, init);
}

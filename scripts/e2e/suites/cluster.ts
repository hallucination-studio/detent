import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

type Pod = 'a' | 'b';
interface Payload {
  object_kind: string;
  object_attributes?: { note?: string; name?: string; title?: string };
  user?: { username?: string };
}
type Match = (payload: Payload) => boolean;
type Serve = (handle: (req: Request) => Promise<Response>, port: number) => Promise<{ baseUrl: string; close(): Promise<void> }>;

// Keep the URL already registered by bootstrap. Only this proxy knows the two backend ports.
export async function webhookProxy(serve: Serve, port: number, backends: Record<Pod, number>, token: string) {
  const pins = new Set<{ pod: Pod; match: Match; receipt?: { uuid: string; body: string; status: number } }>();
  let next: Pod = 'a';
  const proxy = await serve(async req => {
    const body = await req.text();
    const pin = [...pins].find(rule => !rule.receipt && rule.match(JSON.parse(body)));
    if (pin) pins.delete(pin);
    const target = pin?.pod ?? req.headers.get('x-test-pod') ?? next;
    assert.ok(target === 'a' || target === 'b');
    if (!pin) next = next === 'a' ? 'b' : 'a';
    const response = await fetch('http://127.0.0.1:' + backends[target] + '/webhooks/gitlab', {
      method: 'POST', headers: req.headers, body, signal: AbortSignal.timeout(10000),
    });
    if (pin) pin.receipt = { uuid: req.headers.get('x-gitlab-event-uuid')!, body, status: response.status };
    return response;
  }, port);
  return {
    close: proxy.close,
    async pinned<T>(pod: Pod, match: Match, act: () => Promise<T>) {
      const pin: { pod: Pod; match: Match; receipt?: { uuid: string; body: string; status: number } } = { pod, match };
      pins.add(pin);
      try {
        const value = await act();
        assert.equal(pin.receipt?.status, 202, 'Expected an acknowledged webhook on Pod ' + pod);
        return { value, receipt: pin.receipt! };
      } finally { pins.delete(pin); }
    },
    async post(body: string, pod: Pod, uuid: string = randomUUID(), credential: string | null = token) {
      const response = await fetch(proxy.baseUrl + '/webhooks/gitlab', { method: 'POST', body,
        headers: { 'Content-Type': 'application/json', 'X-Test-Pod': pod, 'X-Gitlab-Event-UUID': uuid,
          ...(credential === null ? {} : { 'X-Gitlab-Token': credential }) } });
      await response.arrayBuffer();
      return response.status;
    },
  };
}

export type Cluster = Awaited<ReturnType<typeof webhookProxy>> & {
  start(settings?: NodeJS.ProcessEnv): Promise<void>;
  stop(): Promise<void>;
  sandboxes: string[];
};

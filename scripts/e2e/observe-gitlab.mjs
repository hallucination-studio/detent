// Observe successful GitLab responses in the real Pod. Ignored webhooks have no note or DB receipt.
import { subscribe } from 'node:diagnostics_channel';

const base = new URL(process.env.GITLAB_BASE_URL);
const prefix = base.pathname.replace(/\/$/, '');
subscribe('undici:request:headers', ({ request, response }) => {
  if (request.method !== 'GET' || response.statusCode !== 200 ||
      String(request.origin) !== base.origin || !request.path.startsWith(prefix + '/')) return;
  const path = request.path.slice(prefix.length);
  if (/^\/api\/v4\/projects\/\d+\/(?:members\/all|merge_requests)\/\d+$/.test(path)) process.send?.(path);
});

// A live GitLab REST write may return before its webhook reaches the pod.
subscribe('http.server.response.finish', ({ request, response }) => {
  if (request.url === '/webhooks/gitlab' && response.statusCode === 202) process.send?.('webhook-accepted');
});

// Inspect the actual spawn boundary. Only the pass/fail marker leaves the parent process.
subscribe('tracing:child_process.spawn:start', ({ options }) => {
  if (!options.args?.some(arg => /claude-code[/\\]cli\.js$/.test(arg))) return;
  const vault = Object.entries(process.env).filter(([key]) => key.startsWith('DETENT_SECRET_'));
  const leaked = options.envPairs.some(pair => pair.startsWith('DETENT_SECRET_') || vault.some(([, value]) => value && pair.includes(value)));
  if (leaked) throw Error('Claude subprocess inherited a vault credential');
  process.send?.('isolated-claude-env');
});

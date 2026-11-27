import type { Options } from '@anthropic-ai/claude-code';

// Some tests replace fetch for an external capability. The CLI side always
// reaches the per-turn server through an actual loopback connection.
const http = fetch;

export function turnMcpClient(options: Options) {
  const server = options.mcpServers?.detent;
  if (server?.type !== 'http') throw Error('Expected an HTTP MCP server');
  const { url, headers } = server;
  let id = 0;
  async function rpc(method: string, params?: object) {
    const response = await http(url, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const reply = await response.json();
    if (reply.error) throw Error(reply.error.message);
    if (reply.result.isError) throw Error(reply.result.content[0].text);
    return reply.result;
  }
  return {
    async list(): Promise<string[]> {
      return (await rpc('tools/list')).tools.map((tool: { name: string }) => tool.name);
    },
    call: (name: string, input: object, id?: string) => rpc('tools/call', {
      name, arguments: input, _meta: id && { 'claudecode/toolUseId': id },
    }),
  };
}

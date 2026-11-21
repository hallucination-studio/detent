import { expect, it, vi } from 'vitest';
import { GitLabClient, loadConfig } from '../src/index.js';

it('paginates the repository tree and decodes UTF-8 Markdown at the requested ref', async () => {
  const contents = '# 发布\n说明';
  const http = vi.fn()
    .mockResolvedValueOnce(Response.json([{ name: 'a.md' }], { headers: { 'x-next-page': '2' } }))
    .mockResolvedValueOnce(Response.json([{ name: 'b.md' }]))
    .mockResolvedValueOnce(Response.json({ content: Buffer.from(contents).toString('base64') }));
  const gitlab = new GitLabClient(loadConfig({}), http);
  expect(await gitlab.listRepositoryTree(11, 'work flows', 'stable/v1')).toEqual([{ name: 'a.md' }, { name: 'b.md' }]);
  expect(await gitlab.getRepositoryFile(11, 'work flows/a.md', 'stable/v1')).toBe(contents);
  const urls = http.mock.calls.map(([url]) => new URL(url));
  expect(urls.slice(0, 2).map(url => Object.fromEntries(url.searchParams))).toEqual(['1', '2'].map(page =>
    ({ path: 'work flows', ref: 'stable/v1', page, per_page: '100' })));
  expect(urls[0].pathname).toBe('/api/v4/projects/11/repository/tree');
  expect(urls[2].pathname).toBe('/api/v4/projects/11/repository/files/work%20flows%2Fa.md');
  expect(urls[2].searchParams.get('ref')).toBe('stable/v1');
});

it('maps only HTTP 404 to absent resources', async () => {
  const http = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
  const gitlab = new GitLabClient(loadConfig({}), http);
  const reads = [
    () => gitlab.listRepositoryTree(1, 'workflows', 'main'), () => gitlab.getRepositoryFile(1, 'x.md', 'main'),
    () => gitlab.getTag(1, 'x'), () => gitlab.getCommit(1, 'f'),
  ];
  expect(await Promise.all(reads.map(read => read()))).toEqual([[], null, null, null]);
  http.mockResolvedValue(new Response(null, { status: 403 }));
  for (const read of reads) await expect(read()).rejects.toThrow('403');
});

it('encodes tag, commit and pipeline lookups and sends release writes through the authenticated client', async () => {
  const http = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}));
  const client = new GitLabClient(loadConfig({ GITLAB_TOKEN: 'test' }), http);
  await client.listTags(4, '^v &');
  await client.getTag(4, 'rc/v1');
  await client.getCommit(4, 'abc');
  await client.listPipelinesBySha(4, 'a+b');
  const tag = { tag_name: 'rc/v1', ref: 'abc', message: 'Ready' };
  const release = { tag_name: 'rc/v1', ref: 'abc', name: 'RC', description: 'Notes' };
  await client.createTag(4, tag);
  await client.createRelease(4, release);
  const calls = http.mock.calls.map(([url, init]) => ({ url: new URL(String(url)), init }));
  expect(calls.map(c => c.url.pathname.split('/projects/4/')[1])).toEqual([
    'repository/tags', 'repository/tags/rc%2Fv1', 'repository/commits/abc', 'pipelines', 'repository/tags', 'releases',
  ]);
  expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ per_page: '100', search: '^v &' });
  expect(calls[3].url.searchParams.get('sha')).toBe('a+b');
  for (const { init } of calls) expect(init).toMatchObject({
    redirect: 'error', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'test' }),
  });
  expect(calls.slice(4).map(({ init }) => [init?.method, JSON.parse(String(init?.body))])).toEqual([
    ['POST', tag], ['POST', release],
  ]);
});

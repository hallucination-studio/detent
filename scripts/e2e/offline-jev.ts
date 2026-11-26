import assert from 'node:assert/strict';
import { imageMirror } from './offline-mcp.js';

export function offlineJev() {
  const requests: string[] = [];
  const routingRequests: { recentMessages: string[]; confidence: number; ambiguity: number }[] = [];
  async function handle(req: Request) {
    assert.equal(req.method, 'POST');
    assert.equal(new URL(req.url).pathname, '/compatible-mode/v1/systemone');
    assert.equal(req.headers.get('authorization'), 'Bearer offline-jev-key');
    const { model, state, questions } = await req.json();
    assert.equal(model, 'decision-model-preview');
    if (state.surface === 'hub_agent_routing') {
      assert.equal(questions.agent.type, 'choice');
      assert.equal(questions.clear_match.type, 'noul');
      assert.equal(questions.ambiguity.type, 'score');
      assert.ok(Object.hasOwn(questions.agent.criteria, 'image-sync'));
      const recentMessages: string[] = state.recent_user_messages;
      assert.ok(Array.isArray(recentMessages) && recentMessages.every(message => typeof message === 'string'));
      const clarified = Object.values(imageMirror).every(image => recentMessages.some(message => message.includes(image)));
      const confidence = clarified ? 0.96 : 0.55;
      const ambiguity = clarified ? 0.1 : 2;
      routingRequests.push({ recentMessages, confidence, ambiguity });
      return Response.json({ answers: {
        agent: { type: 'choice', choice: 'image-sync' }, clear_match: { type: 'noul', noul: confidence },
        ambiguity: { type: 'score', score: ambiguity },
      } });
    }
    const remote = state.surface === 'remote_jumpserver_readonly_inspect';
    if (remote) assert.equal(state.command, 'ss -lntp');
    else {
      assert.equal(state.surface, 'local_ephemeral_workspace_bash');
      assert.equal(state.mode, 'coding');
      assert.ok(state.command === 'pwd; ls -la' ||
        /^git -C (projects\/[\w.-]+) status && git -C \1 branch --show-current$/.test(state.command));
    }
    const category = remote ? 'effect' : 'category';
    const safety = remote ? 'zero_side_effect' : 'no_external_impact';
    assert.equal(questions[category].type, 'choice');
    assert.equal(questions[safety].type, 'noul');
    assert.equal(questions.impact.type, 'score');
    requests.push(state.command);
    return Response.json({ answers: {
      [category]: { type: 'choice', choice: remote ? 'pure_readonly' : 'readonly_inspect' },
      [safety]: { type: 'noul', noul: 0.96 }, impact: { type: 'score', score: 0 },
    } });
  }
  return { requests, routingRequests, handle };
}

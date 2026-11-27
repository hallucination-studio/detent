import assert from 'node:assert/strict';
import { kafkaCommands, kafkaTitle } from './suites/kafka.js';
import { imageMirror } from './offline-mcp.js';

export function offlineJev() {
  const requests: string[] = [];
  const eventDecisions: string[] = [];
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
        agent: { type: 'choice', choice: state.issue_title === kafkaTitle ? '__none__' : 'image-sync' }, clear_match: { type: 'noul', noul: confidence },
        ambiguity: { type: 'score', score: ambiguity },
      } });
    }
    if (questions.action) {
      assert.deepEqual(questions.action, { type: 'choice', criteria: { notify: 'notify', run: 'run' } });
      assert.equal(state.hint, 'Notify on infrastructure flakes and fix code errors.');
      assert.match(state.summary, /pipeline.*failed/);
      assert.match(state.summary, /Infrastructure flake|Code error/);
      const choice = state.summary.includes('Infrastructure flake') ? 'notify' : 'run';
      eventDecisions.push(choice);
      return Response.json({ answers: { action: { type: 'choice', choice } } });
    }
    const manual = state.command === 'printf config-loader-ok | cut -c 1-6';
    const remote = state.surface === 'remote_jumpserver_readonly_inspect';
    if (remote) assert.ok([...kafkaCommands, 'date', 'hostname', 'hostname -s', 'date -u'].includes(state.command), 'Unexpected Jev command ' + state.command);
    else {
      assert.equal(state.surface, 'local_ephemeral_workspace_bash');
      assert.equal(state.mode, 'coding');
      assert.ok(manual || state.command === 'pwd; ls -la' ||
        /^git -C (projects\/[\w.-]+) status && git -C \1 branch --show-current$/.test(state.command));
    }
    const category = remote ? 'effect' : 'category';
    const safety = remote ? 'zero_side_effect' : 'no_external_impact';
    assert.equal(questions[category].type, 'choice');
    assert.equal(questions[safety].type, 'noul');
    assert.equal(questions.impact.type, 'score');
    requests.push(state.command);
    return Response.json({ answers: {
      [category]: { type: 'choice', choice: manual ? 'uncertain' : remote ? state.command === 'hostname -s' ? 'state_mutating' : 'pure_readonly' : 'readonly_inspect' },
      [safety]: { type: 'noul', noul: manual ? 0.5 : remote ? 0.79 : 0.96 }, impact: { type: 'score', score: manual ? 2 : state.command === 'date -u' ? 1.4 : remote ? 0.76 : 0 },
    } });
  }
  return { requests, routingRequests, eventDecisions, handle };
}

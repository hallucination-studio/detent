import { afterEach, expect, it, vi } from 'vitest';
import { DeliveryJobPoller, type DeliveryExecutionRow, type JobResultResponse, type JumpServerClient } from '../src/index.js';

const row: DeliveryExecutionRow = {
  id: 'id', sessionId: 'session', mrId: 'mr', approvalId: 'approval', agentProfile: 'env-change',
  jumpserverJobId: 'job-7', jumpserverJobUrl: 'https://jms.test/job-7', playbookPath: 'deploy/site.yml',
  commitSha: 'a'.repeat(40), targetAssets: ['web'], status: 'RUNNING', outputSummary: null, createdAt: new Date(), finishedAt: null,
};
const result: JobResultResponse = { jobId: row.jumpserverJobId, jobUrl: row.jumpserverJobUrl, status: 'SUCCESS', outputSummary: 'healthy' };

function fixture() {
  const auditRepo = {
    listPendingExecutions: vi.fn(async () => [row]),
    acknowledgeCallback: vi.fn(async () => {}),
    completeExecution: vi.fn(async () => true),
  };
  const getJobResult = vi.fn<JumpServerClient['getJobResult']>().mockResolvedValue(result);
  const resolveClient = vi.fn(() => ({ listAssets: vi.fn(), runShell: vi.fn(), runAnsibleJob: vi.fn(), getJobResult }));
  const onCompleted = vi.fn(async () => {});
  const report = vi.fn();
  return { auditRepo, getJobResult, resolveClient, onCompleted, report };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['SUCCESS', 'FAILED'] as const)('only the Pod winning the %s transition wakes the session', async status => {
  const options = fixture();
  const terminal = { ...result, status };
  options.getJobResult.mockResolvedValue(terminal);
  options.auditRepo.completeExecution.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await Promise.all([new DeliveryJobPoller(options).pollOnce(), new DeliveryJobPoller(options).pollOnce()]);
  expect(options.getJobResult.mock.calls).toEqual([[row.jumpserverJobId], [row.jumpserverJobId]]);
  expect(options.auditRepo.completeExecution.mock.calls).toEqual(Array(2).fill([row.sessionId, row.jumpserverJobId, status, result.outputSummary]));
  expect(options.onCompleted).toHaveBeenCalledExactlyOnceWith(row, terminal);
});

it('skips empty scans and unfinished jobs, and isolates per-job errors', async () => {
  const options = fixture();
  const poller = new DeliveryJobPoller(options);
  options.auditRepo.listPendingExecutions.mockResolvedValueOnce([]);
  await poller.pollOnce();
  expect(options.resolveClient).not.toHaveBeenCalled();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  options.auditRepo.listPendingExecutions.mockResolvedValueOnce(['bad', 'running', 'pending', row.jumpserverJobId].map(jumpserverJobId => ({ ...row, jumpserverJobId })));
  options.getJobResult.mockRejectedValueOnce(Error('server unavailable'))
    .mockResolvedValueOnce({ ...result, status: 'RUNNING' }).mockResolvedValueOnce({ ...result, status: 'PENDING' });
  await poller.pollOnce();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('server unavailable'));
  expect(options.auditRepo.completeExecution).toHaveBeenCalledTimes(1);
  expect(options.onCompleted).toHaveBeenCalledExactlyOnceWith(row, result);
});

it('disables at zero, reports scan errors, and drains the current scan on shutdown', async () => {
  vi.useFakeTimers();
  const options = fixture();
  new DeliveryJobPoller({ ...options, intervalMs: 0 }).start();
  await vi.advanceTimersByTimeAsync(6000);
  expect(options.auditRepo.listPendingExecutions).not.toHaveBeenCalled();
  const poller = new DeliveryJobPoller(options);
  const error = Error('database busy');
  options.auditRepo.listPendingExecutions.mockRejectedValueOnce(error);
  let finish!: (result: JobResultResponse) => void;
  options.getJobResult.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  poller.start();
  await vi.advanceTimersByTimeAsync(15000);
  expect(options.report).toHaveBeenCalledExactlyOnceWith(error);
  expect(options.getJobResult).toHaveBeenCalledTimes(1);
  expect(options.auditRepo.listPendingExecutions).toHaveBeenCalledTimes(2);
  const stopped = vi.fn();
  const drain = poller.stop().then(stopped);
  await vi.advanceTimersByTimeAsync(6000);
  expect(stopped).not.toHaveBeenCalled();
  finish(result);
  await drain;
  expect(options.onCompleted).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(3000);
  expect(options.auditRepo.listPendingExecutions).toHaveBeenCalledTimes(2);
});

it('replays a persisted terminal result after callback failure without polling JumpServer again', async () => {
  const options = fixture();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  options.onCompleted.mockRejectedValueOnce(Error('inbox unavailable'));
  await new DeliveryJobPoller(options).pollOnce();
  expect(options.auditRepo.acknowledgeCallback).not.toHaveBeenCalled();
  options.auditRepo.listPendingExecutions.mockResolvedValueOnce([{ ...row, status: 'SUCCESS', outputSummary: 'healthy' }]);
  await new DeliveryJobPoller(options).pollOnce();
  expect(options.getJobResult).toHaveBeenCalledOnce();
  expect(options.onCompleted.mock.lastCall).toEqual([expect.objectContaining({ id: row.id }), result]);
  expect(options.auditRepo.acknowledgeCallback).toHaveBeenCalledExactlyOnceWith(row.sessionId, row.jumpserverJobId);
});

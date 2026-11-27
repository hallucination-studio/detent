import * as fs from 'node:fs/promises';
import { redactGitUrl, scrubJson } from '../gitlab/redact.js';
import path from 'node:path';
import type { DetentRepository } from '../db/repository.js';
import type { IssueSessionRow } from '../types.js';

const encodeProjectPath = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
export function transcriptPath(home: string, cwd: string, id: string) {
  if (!/^[\w-]+$/.test(id)) throw Error('Invalid transcript id');
  return path.join(home, '.claude', 'projects', encodeProjectPath(cwd), id + '.jsonl');
}
export class TranscriptHydrator {
  constructor(private repo: DetentRepository, private secrets: readonly string[] = []) {}
  private scrubLine(raw: string) {
    let changed = false;
    const parsed = scrubJson(JSON.parse(raw), value => {
      const safe = redactGitUrl(value, this.secrets);
      if (safe !== value) changed = true;
      return safe;
    });
    if (!parsed || typeof parsed !== 'object') throw Error('Invalid JSONL message');
    return { parsed, rawJsonLine: changed ? JSON.stringify(parsed) : raw };
  }
  async hydrateTranscriptToTmp(session: IssueSessionRow, home: string, cwd: string) {
    if (!session.claudeSessionId) return;
    const messages = await this.repo.getSessionMessages(session.id);
    if (!messages.length) return;
    const file = transcriptPath(home, cwd, session.claudeSessionId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, messages.map((m) => this.scrubLine(m.rawJsonLine).rawJsonLine + '\n').join(''), { mode: 0o600 });
  }
  async flushIncrementalTranscriptToMySql(session: IssueSessionRow, home: string, cwd: string, id: string) {
    let raw: string;
    try {
      raw = await fs.readFile(transcriptPath(home, cwd, id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const lines = raw.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const offset = session.lastMessageSeq;
    if (lines.length < offset) throw Error('Claude transcript was truncated');
    const batch = lines.slice(offset).map((line, i) => {
      const { parsed, rawJsonLine } = this.scrubLine(line);
      return {
        seq: session.lastMessageSeq + i + 1,
        rawJsonLine,
        messageUuid: 'uuid' in parsed && typeof parsed.uuid === 'string' ? parsed.uuid : null,
        messageType: 'type' in parsed && typeof parsed.type === 'string' ? parsed.type : 'unknown',
      };
    });
    if (batch.length) {
      await this.repo.appendIncrementalMessages(session.id, batch);
      session.lastMessageSeq = batch[batch.length - 1].seq;
    }
  }
}

import { z } from 'zod';
import { configuredSecrets, formatHttpError, logError, redactGitUrl, scrubJson } from '../gitlab/redact.js';
import type { AppConfig } from '../config.js';

export type JevProvider = AppConfig['jevProvider'];
type Provider = Exclude<JevProvider, 'off'>;

export type DecisionQuestion =
  | { type: 'choice'; instructions?: string; criteria: Record<string, string> }
  | { type: 'noul'; instructions?: string; criteria?: { true: string; false: string } }
  | { type: 'score'; instructions?: string; criteria: string[] };

const probability = z.number().finite().min(0).max(1);
const confidence = { confidence: probability.optional(), probabilities: z.record(probability).optional() };
const response = z.object({
  answers: z.record(z.discriminatedUnion('type', [
    z.object({ type: z.literal('choice'), choice: z.string().trim().min(1), ...confidence }),
    z.object({ type: z.literal('noul'), noul: probability }),
    z.object({ type: z.literal('score'), score: z.number().finite().nonnegative(), ...confidence }),
  ])),
});
export type DecisionAnswer = z.infer<typeof response>['answers'][string];
export interface DecisionClient {
  readonly provider: Provider;
  readonly threshold: number;
  decide(state: string | Record<string, unknown>, questions: Record<string, DecisionQuestion>): Promise<Record<string, DecisionAnswer>>;
}

export function resolveJevEndpoint(provider: Provider, baseUrl: string) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  let suffix = '/v1/systemone';
  if (path.endsWith('/systemone')) suffix = '';
  else if (path.endsWith('/v1')) suffix = '/systemone';
  else if (provider === 'bailian' && !path.endsWith('/compatible-mode')) suffix = '/compatible-mode/v1/systemone';
  url.pathname = path + suffix;
  return url.href;
}

class HttpJevDecisionClient implements DecisionClient {
  readonly #secrets: string[];
  private readonly endpoint: string;
  readonly #apiKey?: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  readonly threshold: number;
  constructor(readonly provider: Provider, config: AppConfig, private http: typeof fetch) {
    if (!config.jevBaseUrl || !config.jevModel) throw Error('Missing System One endpoint or model');
    this.#secrets = configuredSecrets(config);
    this.#apiKey = config.jevApiKey;
    this.model = config.jevModel;
    this.timeoutMs = config.jevTimeoutMs;
    this.endpoint = resolveJevEndpoint(provider, config.jevBaseUrl);
    this.threshold = config.jevThreshold;
  }

  async decide(state: string | Record<string, unknown>, questions: Record<string, DecisionQuestion>) {
    let detail: string;
    try {
      const res = await this.http(this.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'Content-Type': 'application/json', ...(this.#apiKey && { Authorization: 'Bearer ' + this.#apiKey }) },
        body: JSON.stringify(scrubJson({ model: this.model, state, questions }, value => redactGitUrl(value, this.#secrets))),
      });
      if (res.ok) {
        const { answers } = response.parse(await res.json());
        for (const [id, question] of Object.entries(questions)) {
          const answer = answers[id];
          if (answer?.type !== question.type) throw Error('Missing or invalid answer type for ' + id);
          if (answer.type === 'choice' && question.type === 'choice' && !Object.hasOwn(question.criteria, answer.choice))
            throw Error('Unexpected choice for ' + id);
        }
        return answers;
      }
      const body = await res.text().catch(error => logError('jev', error, this.#secrets));
      logError('jev', 'Jev HTTP ' + res.status, this.#secrets, body);
      detail = formatHttpError('Jev', res.status, body, this.#secrets);
    } catch (error) {
      detail = logError('jev', error, this.#secrets);
    }
    throw Error('System One decision unavailable or invalid: ' + detail);
  }
}

export function createDecisionClient(config: AppConfig, http: typeof fetch = fetch): DecisionClient | undefined {
  if (config.jevProvider === 'off') return undefined;
  return new HttpJevDecisionClient(config.jevProvider, config, http);
}

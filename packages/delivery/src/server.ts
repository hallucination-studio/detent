import { loadConfig, redactGitUrl } from '@detent/core';
import { loadDeliveryConfig, redactValues } from './config.js';
import { createDeliveryApp } from './index.js';

const coreSecretKeys = new Set(['GITLAB_TOKEN', 'GITLAB_WEBHOOK_SECRET', 'MYSQL_PASSWORD', 'ANTHROPIC_API_KEY', 'JEV_API_KEY']);
const jumpServerSecretKey = /^JUMPSERVER_(READONLY|JOB)_(TOKEN|ACCESS_KEY_ID|ACCESS_KEY_SECRET)$/;

function report(error: unknown) {
  // Also works for startup errors before the credentials have passed validation.
  const secrets = Object.entries(process.env).flatMap(([key, value]) =>
    value && (coreSecretKeys.has(key) || jumpServerSecretKey.test(key)) ? [value, value.trim()] : [],
  );
  console.error(redactValues(redactGitUrl(error instanceof Error ? error.message : String(error)), secrets));
  process.exitCode = 1;
}

async function main() {
  const config = loadConfig();
  const app = createDeliveryApp(config, { deliveryConfig: loadDeliveryConfig() });
  try {
    await app.listen({ host: config.host, port: config.port });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void app.close().catch(report));
  } catch (error) {
    await app.close();
    throw error;
  }
}
main().catch(report);

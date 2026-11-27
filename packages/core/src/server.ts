import { createDetentApp } from './app.js';
import { loadConfig } from './config.js';
import { configuredSecrets, redactGitUrl } from './gitlab/redact.js';

async function main() {
  const config = loadConfig();
  const app = createDetentApp(config);
  const report = (error: unknown) =>
    console.error(redactGitUrl(error instanceof Error ? error.message : String(error), configuredSecrets(config)));
  try {
    await app.listen({ host: config.host, port: config.port });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void app.close().catch(report));
  } catch (error) {
    await app.close();
    throw error;
  }
}
main().catch((error: unknown) => {
  const secrets = Object.entries(process.env).flatMap(([key, value]) =>
    value && (/^DETENT_SECRET_[A-Z0-9_]+$/.test(key) || ['JEV_API_KEY', 'GITLAB_WEBHOOK_SECRET', 'MYSQL_PASSWORD', 'GITLAB_TOKEN', 'ANTHROPIC_API_KEY'].includes(key))
      ? [value.trim()] : []);
  console.error(redactGitUrl(error instanceof Error ? error.message : String(error), secrets));
  process.exitCode = 1;
});

import { createDetentApp } from './app.js';
import { loadConfig } from './config.js';
import { redactGitUrl } from './gitlab/client.js';

async function main() {
  const config = loadConfig();
  const app = createDetentApp(config);
  const report = (error: unknown) =>
    console.error(redactGitUrl(error instanceof Error ? error.message : String(error)));
  try {
    await app.listen({ host: config.host, port: config.port });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void app.close().catch(report));
  } catch (error) {
    await app.close();
    throw error;
  }
}
main().catch((error: unknown) => {
  console.error(redactGitUrl(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});

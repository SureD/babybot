import { createApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const app = await createApp({ config });

const close = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}


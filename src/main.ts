import { loadAppConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { createApp } from './http/app.js';
import { log } from './log.js';

const config = loadAppConfig();
const database = createDatabase(config.DATABASE_URL);
const app = createApp({ db: database.db });

const server = app.listen(config.PORT, () => {
  log.info('server listening', { port: config.PORT });
});

function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  server.close(() => {
    void database.close().then(() => process.exit(0));
  });
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});

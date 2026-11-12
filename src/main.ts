import { createMcpAuth } from './auth/index.js';
import { loadAppConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { createApp } from './http/app.js';
import { log } from './log.js';
import { scheduleRetention } from './services/retention.js';

const config = loadAppConfig();
const database = createDatabase(config.databaseUrl);
const auth = config.auth ? createMcpAuth({ db: database.db, config: config.auth }) : undefined;
if (!auth) log.warn('OAuth not configured: /mcp is disabled');
const app = createApp({ db: database.db, auth });

const stopRetention = scheduleRetention(database.db, config.contactRetentionDays);

const server = app.listen(config.port, () => {
  log.info('server listening', { port: config.port });
});

function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  stopRetention();
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

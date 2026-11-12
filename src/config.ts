import { z } from 'zod';

const postgresUrl = z
  .url({ protocol: /^postgres(ql)?$/ })
  .describe('postgres://user:password@host:port/database');

const appSchema = z.object({
  DATABASE_URL: postgresUrl,
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

const migrationSchema = z.object({
  MIGRATION_DATABASE_URL: postgresUrl,
});

export type AppConfig = z.infer<typeof appSchema>;
export type MigrationConfig = z.infer<typeof migrationSchema>;

function parse<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Only report variable names and issue types, never values: they may contain credentials.
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}

export const loadAppConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig =>
  parse(appSchema, env);

export const loadMigrationConfig = (env: NodeJS.ProcessEnv = process.env): MigrationConfig =>
  parse(migrationSchema, env);

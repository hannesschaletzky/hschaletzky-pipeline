import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { Database } from '../db/client.js';
import {
  type ApplicationFields,
  createApplication,
  getApplication,
  listApplications,
  type NewApplication,
  updateApplication,
  updateStatus,
} from '../db/repositories/applications.js';
import { DomainError } from '../domain/errors.js';
import { APPLICATION_STATUSES } from '../domain/status.js';
import { log } from '../log.js';
import { checkDuplicates } from '../services/duplicate-check.js';
import { importSeed } from '../services/seed-import.js';

const INSTRUCTIONS = `
Tracks the owner's freelance project applications made through agencies and project portals.

Workflow for a new posting:
1. Call check_duplicate with everything known (posting text, location, start date, stack, end
   client, agency). Matches with risk "high" mean the end client has already seen the profile
   through another application — warn clearly before applying again.
2. If it is a new project, call add_application. If it is the same project as an existing
   application, still add it but set same_project_as_id.

Statuses: interesting → applied → presented (profile forwarded to the end client) → interview →
offer → won; or rejected / withdrawn / skipped. Any status may follow any other, including
reopening. Use update_status for status changes (it records history) and update_application for
everything else.

Dates are ISO (YYYY-MM-DD). Stack terms are normalised automatically.
`.trim();

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'invalid date');
const status = z.enum(APPLICATION_STATUSES);
const id = z.number().int().positive();
const text = z.string().trim().min(1);

const fieldShape = {
  agency: text.nullish().describe('Agency or portal name; created on first use'),
  agency_project_id: text.nullish().describe("The agency's reference number for the posting"),
  contact: z
    .object({ name: text, email: z.email().nullish(), phone: text.nullish() })
    .nullish()
    .describe('Contact person at the agency'),
  end_client: text.nullish().describe('End client name, if known'),
  end_client_hints: text.nullish().describe('Clues about an unnamed end client'),
  location: text.nullish(),
  remote_share: z.number().int().min(0).max(100).nullish().describe('Remote share in percent'),
  start_date: isoDate.nullish(),
  end_date: isoDate.nullish(),
  duration_text: text.nullish().describe('Duration as written, e.g. "12 months + extension"'),
  stack: z.array(text).optional().describe('Technologies, e.g. ["TypeScript", "React"]'),
  posting_text: text.nullish().describe('Full posting text'),
  cover_letter: text.nullish(),
  cv_variant: text.nullish(),
  rate_eur: z.number().int().positive().nullish().describe('Rate in whole euros'),
  rate_unit: z.enum(['hour', 'day']).optional().describe('Unit of rate_eur, default hour'),
  notes: text.nullish(),
  same_project_as_id: id.nullish().describe('Existing application for the same end-client project'),
};

const newApplicationShape = { title: text, status: status.optional(), ...fieldShape };

type FieldInput = z.infer<z.ZodObject<typeof fieldShape>>;

/** snake_case tool input → repository fields. `undefined` means "not given". */
function toFields(input: FieldInput): ApplicationFields {
  return {
    agency: input.agency,
    agencyProjectId: input.agency_project_id,
    contact: input.contact,
    endClient: input.end_client,
    endClientHints: input.end_client_hints,
    location: input.location,
    remoteShare: input.remote_share,
    startDate: input.start_date,
    endDate: input.end_date,
    durationText: input.duration_text,
    stack: input.stack,
    postingText: input.posting_text,
    coverLetter: input.cover_letter,
    cvVariant: input.cv_variant,
    rateEur: input.rate_eur,
    rateUnit: input.rate_unit,
    notes: input.notes,
    sameProjectAsId: input.same_project_as_id,
  };
}

function toNewApplication(input: z.infer<z.ZodObject<typeof newApplicationShape>>): NewApplication {
  return { ...toFields(input), title: input.title, status: input.status };
}

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const failure = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

/** Postgres constraint errors that stem from invalid input, not from bugs. */
function inputErrorMessage(error: unknown): string | null {
  const code = (error as { cause?: { code?: string } }).cause?.code;
  if (code === '23503') return 'Referenced application does not exist';
  if (code === '23514') return 'Invalid combination of values (e.g. end date before start date)';
  return null;
}

/** Runs a tool handler; logs tool name and outcome only, never arguments or results. */
function tool<A>(name: string, handler: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<CallToolResult> => {
    const started = performance.now();
    try {
      const result = ok(await handler(args));
      log.info('tool call', { tool: name, ok: true, ms: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      const known = error instanceof DomainError ? error.message : inputErrorMessage(error);
      log.warn('tool call', {
        tool: name,
        ok: false,
        error: error instanceof Error ? error.name : 'unknown',
        ms: Math.round(performance.now() - started),
      });
      return failure(known ?? 'Internal error');
    }
  };
}

const readOnly = { readOnlyHint: true, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function createMcpServer({ db }: { db: Database }): McpServer {
  const server = new McpServer(
    { name: 'hschaletzky-pipeline', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'check_duplicate',
    {
      title: 'Check for duplicate projects',
      description:
        'Finds existing applications that may be the same end-client project as a new posting. ' +
        'Pass everything known; each match has a score, a risk (high = end client has already ' +
        'seen the profile) and human-readable reasons.',
      inputSchema: {
        posting_text: text.optional(),
        location: text.optional(),
        start_date: isoDate.optional(),
        stack: z.array(text).optional(),
        end_client: text.optional(),
        agency: text.optional(),
        agency_project_id: text.optional(),
        exclude_id: id.optional().describe('Leave out this application (when re-checking it)'),
      },
      annotations: readOnly,
    },
    tool('check_duplicate', async (args) => {
      const matches = await checkDuplicates(db, {
        postingText: args.posting_text,
        location: args.location,
        startDate: args.start_date,
        stack: args.stack,
        endClient: args.end_client,
        agency: args.agency,
        agencyProjectId: args.agency_project_id,
        excludeId: args.exclude_id,
      });
      return { matches };
    }),
  );

  server.registerTool(
    'add_application',
    {
      title: 'Add application',
      description:
        'Creates an application (default status "interesting"). Returns its id and any ' +
        'possible duplicates found afterwards.',
      inputSchema: newApplicationShape,
      annotations: writes,
    },
    tool('add_application', async (args) => {
      const { id: newId } = await createApplication(db, toNewApplication(args));
      const duplicates = await checkDuplicates(db, {
        postingText: args.posting_text,
        location: args.location,
        startDate: args.start_date,
        stack: args.stack,
        endClient: args.end_client,
        agency: args.agency,
        agencyProjectId: args.agency_project_id,
        excludeId: newId,
      });
      return { id: newId, possibleDuplicates: duplicates };
    }),
  );

  server.registerTool(
    'update_status',
    {
      title: 'Update status',
      description:
        'Changes the status of an application and records it in the history, optionally ' +
        'with a note. Any status may follow any other, including reopening a closed one.',
      inputSchema: { id, status, note: text.optional() },
      annotations: writes,
    },
    tool('update_status', async (args) => updateStatus(db, args.id, args.status, args.note)),
  );

  server.registerTool(
    'update_application',
    {
      title: 'Update application',
      description:
        'Changes fields of an application (not the status — use update_status). Only given ' +
        'fields change; pass null to clear one. Set same_project_as_id to confirm a duplicate.',
      inputSchema: { id, title: text.optional(), ...fieldShape },
      annotations: { ...writes, idempotentHint: true },
    },
    tool('update_application', async ({ id: appId, title, ...fields }) =>
      updateApplication(db, appId, { ...toFields(fields), title }),
    ),
  );

  server.registerTool(
    'list_applications',
    {
      title: 'List applications',
      description: 'Overview of applications, most recently updated first.',
      inputSchema: {
        status: z.array(status).optional().describe('Only these statuses'),
        agency: text.optional().describe('Only this agency'),
        since: isoDate.optional().describe('Only applications created on or after this date'),
      },
      annotations: readOnly,
    },
    tool('list_applications', async (args) => ({
      applications: await listApplications(db, args),
    })),
  );

  server.registerTool(
    'get_application',
    {
      title: 'Get application',
      description:
        'All details of one application, including contact, history and applications ' +
        'confirmed as the same project.',
      inputSchema: { id },
      annotations: readOnly,
    },
    tool('get_application', async (args) => getApplication(db, args.id)),
  );

  server.registerTool(
    'import_seed',
    {
      title: 'Import existing applications',
      description:
        'One-off import of existing applications, all or nothing. Refuses to run if ' +
        'applications already exist unless allow_existing is true.',
      inputSchema: {
        entries: z.array(z.object(newApplicationShape)).min(1),
        allow_existing: z.boolean().optional(),
      },
      annotations: writes,
    },
    tool('import_seed', async (args) =>
      importSeed(db, args.entries.map(toNewApplication), {
        allowExisting: args.allow_existing ?? false,
      }),
    ),
  );

  return server;
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../../src/db/client.js';
import {
  createApplication,
  getApplication,
  listApplications,
  updateApplication,
  updateStatus,
} from '../../src/db/repositories/applications.js';
import { InvalidInputError, NotFoundError } from '../../src/domain/errors.js';
import { checkDuplicates } from '../../src/services/duplicate-check.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';

// All data below is invented.
let testDb: TestDatabase;
let handle: DatabaseHandle;
const db = () => handle.db;

beforeAll(async () => {
  testDb = await startTestDatabase();
  handle = createDatabase(testDb.appUrl);
});

afterAll(async () => {
  await handle.close();
  await testDb.container.stop();
});

const POSTING_A1 =
  'Für unseren Kunden, ein großes Versicherungsunternehmen in Musterstadt, suchen wir einen ' +
  'Senior Fullstack Entwickler (m/w/d) mit TypeScript, React und Node.js. Start: 01.03.2027, ' +
  'Laufzeit 12 Monate mit Option auf Verlängerung, 80 % remote. Aufgaben: Weiterentwicklung ' +
  'eines Kundenportals, Migration von Legacy-Komponenten, Aufbau von CI/CD-Pipelines.';
const POSTING_A2 =
  'Senior Fullstack Developer (TypeScript/React/Node) gesucht! Unser Kunde aus der ' +
  'Versicherungsbranche (Raum Musterstadt) modernisiert sein Kundenportal. Projektstart März ' +
  '2027, 12 Monate + Verlängerung, ca. 80% Remote-Anteil. Ihre Aufgaben: Migration alter ' +
  'Komponenten, Weiterentwicklung des Portals, CI/CD-Pipelines aufbauen.';

describe('applications repository', () => {
  it('creates an application with organisations, contact and initial event', async () => {
    const { id } = await createApplication(db(), {
      title: 'Senior Fullstack Developer',
      agency: 'Muster Consulting GmbH',
      contact: { name: 'Max Mustermann', email: 'max@example.com' },
      endClient: 'Beispiel Versicherung AG',
      location: 'Musterstadt',
      startDate: '2027-03-01',
      stack: ['TS', 'React', 'Node.js'],
      rateEur: 760,
      rateUnit: 'day',
    });

    const application = await getApplication(db(), id);
    expect(application).toMatchObject({
      status: 'interesting',
      agency: 'Muster Consulting GmbH',
      endClient: 'Beispiel Versicherung AG',
      contact: { name: 'Max Mustermann', email: 'max@example.com' },
      stack: ['nodejs', 'react', 'typescript'],
      rateUnit: 'day',
      closedAt: null,
    });
    expect(application.events.map((e) => e.type)).toEqual(['status_change', 'contact']);
  });

  it('reuses organisations across spellings', async () => {
    const a = await createApplication(db(), { title: 'A', agency: 'Fiktiv Projekte GmbH' });
    const b = await createApplication(db(), { title: 'B', agency: 'FIKTIV Projekte' });
    const [first, second] = await Promise.all([
      getApplication(db(), a.id),
      getApplication(db(), b.id),
    ]);
    expect(second.agencyId).toBe(first.agencyId);
  });

  it('closes, reopens and records every status change with notes', async () => {
    const { id } = await createApplication(db(), { title: 'Cloud Architect' });
    await updateStatus(db(), id, 'applied');
    await updateStatus(db(), id, 'rejected', 'Client chose an internal candidate');
    expect((await getApplication(db(), id)).closedAt).toBeInstanceOf(Date);

    await updateStatus(db(), id, 'presented', 'Agency came back, client reconsidered');
    const application = await getApplication(db(), id);
    expect(application.closedAt).toBeNull();
    expect(application.events.map((e) => e.payload)).toEqual([
      { type: 'status_change', from: null, to: 'interesting' },
      { type: 'status_change', from: 'interesting', to: 'applied' },
      { type: 'status_change', from: 'applied', to: 'rejected' },
      { type: 'note', text: 'Client chose an internal candidate' },
      { type: 'status_change', from: 'rejected', to: 'presented' },
      { type: 'note', text: 'Agency came back, client reconsidered' },
    ]);
  });

  it('rejects setting the same status again and unknown ids', async () => {
    const { id } = await createApplication(db(), { title: 'Data Engineer' });
    await expect(updateStatus(db(), id, 'interesting')).rejects.toBeInstanceOf(InvalidInputError);
    await expect(updateStatus(db(), 999_999, 'applied')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('updates fields and records only field names in the history', async () => {
    const { id } = await createApplication(db(), { title: 'QA Engineer' });
    await updateApplication(db(), id, {
      coverLetter: 'Sehr geehrte Damen und Herren …',
      rateEur: 90,
    });

    const application = await getApplication(db(), id);
    expect(application.coverLetter).toBe('Sehr geehrte Damen und Herren …');
    expect(application.events.at(-1)?.payload).toEqual({
      type: 'update',
      fields: ['coverLetter', 'rateEur'],
    });
  });

  it('lists applications filtered by status and agency', async () => {
    const { id } = await createApplication(db(), {
      title: 'Platform Engineer',
      agency: 'Listen Test Personal GmbH',
      status: 'applied',
    });
    const rows = await listApplications(db(), {
      status: ['applied'],
      agency: 'listen test personal',
    });
    expect(rows.map((r) => r.id)).toEqual([id]);
  });
});

describe('duplicate check', () => {
  it('finds the same project posted by another agency, with high risk once presented', async () => {
    const original = await createApplication(db(), {
      title: 'Senior Fullstack Developer',
      agency: 'Erste Vermittlung GmbH',
      location: 'Musterstadt',
      startDate: '2027-03-01',
      stack: ['typescript', 'react', 'node'],
      postingText: POSTING_A1,
    });
    await updateStatus(db(), original.id, 'applied');
    await updateStatus(db(), original.id, 'presented');

    const matches = await checkDuplicates(db(), {
      postingText: POSTING_A2,
      location: 'Musterstadt (remote)',
      startDate: '2027-03-15',
      stack: ['TypeScript', 'React', 'Node.js'],
    });

    const match = matches.find((m) => m.applicationId === original.id);
    expect(match).toMatchObject({ risk: 'high', agency: 'Erste Vermittlung GmbH' });
    expect(match?.reasons).toEqual([
      '100 % stack overlap, musterstadt, start 2027-03-15 vs 2027-03-01',
      expect.stringMatching(/^similar posting text \(\d+ %\)$/),
    ]);
  });

  it('includes applications linked as the same project', async () => {
    const first = await createApplication(db(), {
      title: 'SAP Consultant',
      endClient: 'Gedacht Logistik GmbH',
    });
    const linked = await createApplication(db(), {
      title: 'SAP Consultant (second agency)',
      sameProjectAsId: first.id,
    });

    const matches = await checkDuplicates(db(), { endClient: 'Gedacht Logistik' });
    expect(matches.map((m) => m.applicationId).sort()).toEqual([first.id, linked.id].sort());
  });

  it('finds nothing for an unrelated posting', async () => {
    const matches = await checkDuplicates(db(), {
      postingText: 'Embedded C Entwickler für Steuergeräte, Start 2028, Beispielhausen.',
      location: 'Beispielhausen',
      startDate: '2028-01-01',
      stack: ['c', 'autosar'],
    });
    expect(matches).toEqual([]);
  });
});

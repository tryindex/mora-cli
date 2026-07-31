import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchesProject } from '../src/commands/connection.js';
import {
  ADC_FILENAME,
  detectGcloud,
  type GcloudState,
  listBigQueryProjects,
  type ProjectTransport,
} from '../src/gcloud.js';

const signedIn: GcloudState = { adc: 'file', adcPath: '/dev/null/not-read-by-these-tests' };

/** A row as BigQuery's `projects.list` returns one. */
interface ProjectRow {
  id?: string;
  friendlyName?: string;
  projectReference?: { projectId?: string };
}

function entry(id: string, friendlyName?: string): ProjectRow {
  return { id, projectReference: { projectId: id }, ...(friendlyName ? { friendlyName } : {}) };
}

/** A transport over canned pages, recording the URLs it was asked for. */
function pages(responses: { projects?: ProjectRow[]; nextPageToken?: string }[]): {
  transport: ProjectTransport;
  urls: string[];
} {
  const urls: string[] = [];
  let call = 0;
  return {
    urls,
    transport: async (url) => {
      urls.push(url);
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return response ?? {};
    },
  };
}

describe('listBigQueryProjects', () => {
  it('returns the projects the credentials can query, named where they have a name', async () => {
    const { transport } = pages([
      { projects: [entry('acme-prod', 'Acme Production'), entry('sandbox')] },
    ]);

    const list = await listBigQueryProjects(signedIn, transport);

    expect(list.truncated).toBe(false);
    expect(list.projects).toEqual([
      { id: 'acme-prod', name: 'Acme Production' },
      { id: 'sandbox' },
    ]);
  });

  it('follows the page token rather than stopping at a short page', async () => {
    // A real short-but-not-last page: the API returns fewer rows than asked for
    // and still has more to give.
    const { transport, urls } = pages([
      { projects: [entry('one')], nextPageToken: 't1' },
      { projects: [entry('two')], nextPageToken: 't2' },
      { projects: [entry('three')] },
    ]);

    const list = await listBigQueryProjects(signedIn, transport);

    expect(list.projects.map((project) => project.id)).toEqual(['one', 'three', 'two']);
    expect(list.truncated).toBe(false);
    expect(urls).toHaveLength(3);
    expect(urls[1]).toContain('pageToken=t1');
    expect(urls[2]).toContain('pageToken=t2');
  });

  it('stops at a page limit and says the list is partial', async () => {
    // Every page offers another, so only the cap can end this.
    const { transport, urls } = pages([{ projects: [entry('endless')], nextPageToken: 'more' }]);

    const list = await listBigQueryProjects(signedIn, transport);

    expect(list.truncated).toBe(true);
    expect(urls.length).toBeLessThanOrEqual(10);
  });

  it('keeps what arrived when a later page fails', async () => {
    let call = 0;
    const transport: ProjectTransport = async () => {
      call += 1;
      if (call === 1) return { projects: [entry('first')], nextPageToken: 't1' };
      throw new Error('403 Forbidden');
    };

    const list = await listBigQueryProjects(signedIn, transport);

    expect(list.projects.map((project) => project.id)).toEqual(['first']);
    expect(list.truncated).toBe(true);
  });

  it('reports nothing rather than throwing when the very first call fails', async () => {
    const transport: ProjectTransport = async () => {
      throw new Error('network is down');
    };

    await expect(listBigQueryProjects(signedIn, transport)).resolves.toEqual({
      projects: [],
      truncated: false,
    });
  });

  it('does not call the API at all when there are no credentials', async () => {
    let called = false;
    const transport: ProjectTransport = async () => {
      called = true;
      return {};
    };

    const list = await listBigQueryProjects({ adc: null }, transport);

    // The transport is only ever reached through credentials, so an unauthenticated
    // state must not produce a request.
    expect(list.projects).toEqual([]);
    expect(called).toBe(false);
  });

  it('ignores entries with no project id and deduplicates repeats across pages', async () => {
    const { transport } = pages([
      { projects: [{ friendlyName: 'nameless' }, entry('acme')], nextPageToken: 't1' },
      { projects: [entry('acme', 'Acme')] },
    ]);

    const list = await listBigQueryProjects(signedIn, transport);

    expect(list.projects).toEqual([{ id: 'acme', name: 'Acme' }]);
  });
});

describe('project search', () => {
  it('matches on the id and on the display name, case-insensitively', () => {
    expect(matchesProject('acme', 'acme-prod', 'Production')).toBe(true);
    expect(matchesProject('PROD', 'acme-prod', 'Production')).toBe(true);
    expect(matchesProject('duction', 'acme-prod', 'Production')).toBe(true);
    expect(matchesProject('retail', 'acme-prod', 'Production')).toBe(false);
  });

  it('shows everything when nothing has been typed', () => {
    expect(matchesProject('   ', 'acme-prod', 'Production')).toBe(true);
  });

  it('keeps manual entry reachable however the search narrows', () => {
    expect(matchesProject('nothing-matches-this', 'mora:enter-by-hand', 'Enter by hand')).toBe(
      true,
    );
  });

  it('copes with an option that has no label', () => {
    expect(matchesProject('acme', 'acme-prod')).toBe(true);
    expect(matchesProject('other', 'acme-prod')).toBe(false);
  });
});

const bigqueryProject = process.env.GOOGLE_CLOUD_PROJECT;
describe.skipIf(!bigqueryProject)('against real Google credentials', () => {
  it('lists projects this account can actually query', async () => {
    const state = await detectGcloud();
    const list = await listBigQueryProjects(state);

    expect(list.projects.length).toBeGreaterThan(0);
    for (const project of list.projects) {
      expect(project.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('skips the API when the credentials file is not one it understands', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mora-adc-'));
    const adcPath = path.join(dir, ADC_FILENAME);
    await writeFile(adcPath, JSON.stringify({ type: 'external_account' }), 'utf8');

    const list = await listBigQueryProjects({ adc: 'file', adcPath });

    expect(list).toEqual({ projects: [], truncated: false });
  });
});

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchesProject, projectOptions } from '../src/commands/connection.js';
import {
  ADC_FILENAME,
  type DatasetTransport,
  detectGcloud,
  findProjectsWithData,
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

describe('findProjectsWithData', () => {
  /** A transport where the named projects have a dataset and the rest do not. */
  function datasets(withData: string[], broken: string[] = []) {
    const asked: string[] = [];
    const transport: DatasetTransport = async (projectId) => {
      asked.push(projectId);
      if (broken.includes(projectId)) throw new Error('403 accessDenied');
      return withData.includes(projectId) ? { datasets: [{ id: 'one' }] } : { datasets: [] };
    };
    return { transport, asked };
  }

  it('keeps the projects that hold a dataset and drops the empty ones', async () => {
    const { transport } = datasets(['has-data']);

    const probe = await findProjectsWithData(signedIn, ['has-data', 'empty'], transport);

    expect([...probe.withData]).toEqual(['has-data']);
    expect(probe.complete).toBe(true);
  });

  it('treats a project it cannot read as one with nothing to read', async () => {
    // BigQuery switched off, or no permission to list datasets: either way there
    // is nothing here to point a model at, and the sweep still finishes.
    const { transport, asked } = datasets(['has-data'], ['forbidden']);

    const probe = await findProjectsWithData(
      signedIn,
      ['has-data', 'forbidden', 'empty'],
      transport,
    );

    expect([...probe.withData]).toEqual(['has-data']);
    expect(probe.complete).toBe(true);
    expect(asked).toHaveLength(3);
  });

  it('asks about every project exactly once, however many there are', async () => {
    const ids = Array.from({ length: 60 }, (_unused, index) => `project-${index}`);
    const { transport, asked } = datasets(['project-7', 'project-59']);

    const probe = await findProjectsWithData(signedIn, ids, transport);

    expect(asked.sort()).toEqual([...ids].sort());
    expect([...probe.withData].sort()).toEqual(['project-59', 'project-7']);
  });

  it('reports itself incomplete when there are no credentials, without asking', async () => {
    const { transport, asked } = datasets(['has-data']);

    const probe = await findProjectsWithData({ adc: null }, ['has-data'], transport);

    // Incomplete is what makes the caller offer every project: an empty set from
    // a sweep that never ran must not be read as "none of these have data".
    expect(probe).toEqual({ withData: new Set(), complete: false });
    expect(asked).toEqual([]);
  });

  it('is complete and empty when asked about nothing', async () => {
    const { transport } = datasets([]);

    await expect(findProjectsWithData(signedIn, [], transport)).resolves.toEqual({
      withData: new Set(),
      complete: true,
    });
  });
});

describe('project options', () => {
  const shortlist = [{ id: 'acme-prod', name: 'Acme Production' }, { id: 'sandbox' }];

  it('offers a way to see the projects a shortlist left out', () => {
    const options = projectOptions(shortlist, 158);

    expect(options.map((option) => option.label)).toEqual([
      'Acme Production',
      'sandbox',
      'Show all 158 projects',
      'Enter a project id by hand',
    ]);
    // Named projects show their id too, since that is what lands in mora.yaml.
    expect(options[0]?.hint).toBe('acme-prod');
    expect(options[1]?.hint).toBeUndefined();
  });

  it('leaves out the way to see everything when everything is already shown', () => {
    const options = projectOptions(shortlist, shortlist.length);

    expect(options.map((option) => option.value)).toEqual([
      'acme-prod',
      'sandbox',
      'mora:enter-by-hand',
    ]);
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

  it('keeps the way out of a filtered shortlist reachable too', () => {
    // A reader searching a shortlist for a project that was filtered out needs
    // "show all" still on screen, or the search looks like the project is gone.
    expect(matchesProject('nothing-matches-this', 'mora:show-all', 'Show all 158 projects')).toBe(
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

  it('narrows those projects to the ones that actually hold data', async () => {
    const state = await detectGcloud();
    const list = await listBigQueryProjects(state);
    const ids = list.projects.map((project) => project.id);

    const probe = await findProjectsWithData(state, ids);

    expect(probe.complete).toBe(true);
    // The point of the sweep: a real account holds roles on far more projects
    // than it keeps data in.
    expect(probe.withData.size).toBeLessThanOrEqual(ids.length);
    for (const id of probe.withData) expect(ids).toContain(id);
  });

  it('skips the API when the credentials file is not one it understands', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mora-adc-'));
    const adcPath = path.join(dir, ADC_FILENAME);
    await writeFile(adcPath, JSON.stringify({ type: 'external_account' }), 'utf8');

    const list = await listBigQueryProjects({ adc: 'file', adcPath });

    expect(list).toEqual({ projects: [], truncated: false });
  });
});

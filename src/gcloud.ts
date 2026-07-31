import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
// Type-only, so it is erased at build and the library itself stays lazy.
import type { JWTInput } from 'google-auth-library';

export const ADC_FILENAME = 'application_default_credentials.json';
export const ADC_LOGIN_COMMAND = 'gcloud auth application-default login';

/** Where a set of Application Default Credentials was found. */
export type AdcSource = 'environment' | 'file';

export interface GcloudState {
  /**
   * Where the Google client libraries will find credentials, or null when they
   * would find none. `environment` means GOOGLE_APPLICATION_CREDENTIALS points at
   * a key file, which takes precedence over anything gcloud wrote.
   */
  adc: AdcSource | null;
  /** Absolute path of the credentials file backing `adc`, when there is one. */
  adcPath?: string;
  /** `[core] project` from the active gcloud configuration. */
  project?: string;
  /** `[core] account` from the active gcloud configuration. */
  account?: string;
}

/** A project the credentials can run BigQuery in. */
export interface GcloudProject {
  id: string;
  /** Display name, when the project has one that differs from its id. */
  name?: string;
}

export interface ProjectList {
  projects: GcloudProject[];
  /**
   * True when the listing stopped at a limit rather than at the end, so the
   * reader can be told the list is partial instead of assuming a project is
   * missing because they lack access to it.
   */
  truncated: boolean;
}

/** One page of BigQuery's `projects.list`, as the caller of a transport sees it. */
interface ProjectPage {
  projects?: {
    id?: string;
    friendlyName?: string;
    projectReference?: { projectId?: string };
  }[];
  nextPageToken?: string;
}

/** Issues one authenticated GET and parses the JSON body. Injectable for tests. */
export type ProjectTransport = (url: string) => Promise<ProjectPage>;

const PROJECTS_ENDPOINT = 'https://bigquery.googleapis.com/bigquery/v2/projects';
const BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery';
const PAGE_SIZE = 200;
/** Enough for a large organisation, and a bound on how long this can take. */
const MAX_PAGES = 10;
const TIME_BUDGET_MS = 15_000;

/**
 * The projects these credentials can actually run BigQuery in. BigQuery's own
 * `projects.list` is used rather than Cloud Resource Manager because it needs no
 * further API enabled and every project it returns can run a query — offering
 * one that cannot would be offering a broken connection.
 *
 * Returns an empty list rather than throwing. This only ever populates a picker;
 * a reader who cannot list projects can still type one, and an error here must
 * not end a setup that was otherwise going fine.
 */
export async function listBigQueryProjects(
  state: GcloudState,
  transport?: ProjectTransport,
): Promise<ProjectList> {
  // Checked before any transport is chosen, injected or not: without credentials
  // there is nothing to authenticate with, so there is no request to make.
  if (state.adc === null) return { projects: [], truncated: false };

  const request = transport ?? (await bigQueryTransport(state));
  if (!request) return { projects: [], truncated: false };

  const seen = new Map<string, GcloudProject>();
  const deadline = Date.now() + TIME_BUDGET_MS;
  let token: string | undefined;
  let pages = 0;

  try {
    do {
      const page = await request(pageUrl(token));
      pages += 1;

      for (const entry of page.projects ?? []) {
        const id = entry.projectReference?.projectId ?? entry.id;
        if (!id) continue;
        const name = entry.friendlyName?.trim();
        seen.set(id, { id, ...(name && name !== id ? { name } : {}) });
      }

      // The API can return fewer rows than asked for and still have more pages,
      // so the token is the only reliable signal that the list is exhausted.
      token = page.nextPageToken || undefined;
      if (token && (pages >= MAX_PAGES || Date.now() > deadline)) {
        return { projects: sortProjects(seen), truncated: true };
      }
    } while (token);
  } catch {
    // A partial list is still better than none: the reader may well see the
    // project they wanted in what did arrive.
    return { projects: sortProjects(seen), truncated: seen.size > 0 };
  }

  return { projects: sortProjects(seen), truncated: false };
}

/** One page of `datasets.list`, trimmed to the one thing the sweep asks of it. */
interface DatasetPage {
  datasets?: unknown[];
}

/** Answers "does this project hold any data". Injectable for tests. */
export type DatasetTransport = (projectId: string) => Promise<DatasetPage>;

export interface DataProbe {
  /** Projects holding at least one dataset these credentials can see. */
  withData: Set<string>;
  /**
   * False when some projects went unchecked, so `withData` is not the whole
   * answer. A caller that hides projects must show all of them instead: hiding
   * one that does have data is worse than listing one that does not.
   */
  complete: boolean;
}

const PROBE_CONCURRENCY = 16;
/**
 * Long enough for a few hundred projects, short enough that a reader is not left
 * watching a spinner. Beyond it the sweep reports itself incomplete.
 */
const PROBE_BUDGET_MS = 8_000;

/**
 * Which of these projects have data to read. `projects.list` returns everything
 * the caller holds any role on, which in an organisation is mostly projects that
 * have never used BigQuery; a project with no datasets can open a connection and
 * answer no questions, which is the half-configured state worth avoiding.
 *
 * There is no API that answers this in one call, so it is one `datasets.list` per
 * project, capped at one row, run a few at a time. Errors are per project and
 * never thrown: no permission to list datasets and BigQuery switched off both
 * mean the same thing to a reader choosing where to point a model.
 */
export async function findProjectsWithData(
  state: GcloudState,
  projectIds: string[],
  transport?: DatasetTransport,
): Promise<DataProbe> {
  if (state.adc === null) return { withData: new Set(), complete: false };

  const request = transport ?? (await datasetTransport(state));
  if (!request) return { withData: new Set(), complete: false };

  const withData = new Set<string>();
  const deadline = Date.now() + PROBE_BUDGET_MS;
  const queue = [...projectIds];
  let unchecked = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      const projectId = queue.shift();
      if (projectId === undefined) return;
      if (Date.now() > deadline) {
        unchecked = true;
        return;
      }
      try {
        const page = await request(projectId);
        if ((page.datasets ?? []).length > 0) withData.add(projectId);
      } catch {
        // Treated as no data, and deliberately not fatal: one unreadable project
        // out of hundreds must not throw away everything the sweep did learn.
      }
    }
  };

  const workers = Math.min(PROBE_CONCURRENCY, queue.length);
  await Promise.all(Array.from({ length: workers }, worker));

  return { withData, complete: !unchecked };
}

function pageUrl(token: string | undefined): string {
  const url = new URL(PROJECTS_ENDPOINT);
  url.searchParams.set('maxResults', String(PAGE_SIZE));
  if (token) url.searchParams.set('pageToken', token);
  return url.toString();
}

function sortProjects(seen: Map<string, GcloudProject>): GcloudProject[] {
  return [...seen.values()].sort((a, b) =>
    (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: 'base' }),
  );
}

async function bigQueryTransport(state: GcloudState): Promise<ProjectTransport | undefined> {
  const get = await authorizedGet(state);
  return get && ((url) => get<ProjectPage>(url));
}

async function datasetTransport(state: GcloudState): Promise<DatasetTransport | undefined> {
  const get = await authorizedGet(state);
  if (!get) return undefined;

  return (projectId) => {
    const url = new URL(`${PROJECTS_ENDPOINT}/${encodeURIComponent(projectId)}/datasets`);
    // One row is all the question needs; asking for a project's whole dataset
    // list would be paying to page through data nobody reads.
    url.searchParams.set('maxResults', '1');
    return get<DatasetPage>(url.toString());
  };
}

/**
 * An authenticated GET against BigQuery, built from the credentials file
 * detection already found. `GoogleAuth.getClient()` is deliberately not used: it
 * probes for a GCE metadata server, which costs about nine seconds on a laptop,
 * where reading the file we have already located costs milliseconds.
 */
async function authorizedGet(
  state: GcloudState,
): Promise<(<T>(url: string) => Promise<T>) | undefined> {
  if (!state.adcPath) return undefined;

  try {
    const credentials: unknown = JSON.parse(await readFile(state.adcPath, 'utf8'));
    if (typeof credentials !== 'object' || credentials === null) return undefined;

    // Lazily imported: the Google client libraries are worth loading only for a
    // reader who is actually setting up BigQuery, never for `mora --help`.
    const { GoogleAuth } = await import('google-auth-library');
    const client = new GoogleAuth({ scopes: [BIGQUERY_SCOPE] }).fromJSON(credentials as JWTInput);

    return async <T>(url: string) => (await client.request<T>({ url })).data;
  } catch {
    // An external-account or otherwise unsupported credential file lands here.
    // The picker is skipped; typing a project id still works.
    return undefined;
  }
}

/**
 * What the Google client libraries would authenticate as, read from disk rather
 * than by running `gcloud`. A subprocess would be slow, needs the SDK on PATH,
 * and tells us nothing the files do not: gcloud stores its state as JSON and an
 * ini-style config. Anything missing or unreadable means "not detected", never
 * an error — detection only ever improves a default.
 */
export async function detectGcloud(env: NodeJS.ProcessEnv = process.env): Promise<GcloudState> {
  const configDir = gcloudConfigDir(env);
  const state: GcloudState = { adc: null };

  const fromEnv = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (fromEnv && existsSync(fromEnv)) {
    state.adc = 'environment';
    state.adcPath = fromEnv;
  } else if (configDir) {
    const adcPath = path.join(configDir, ADC_FILENAME);
    if (existsSync(adcPath)) {
      state.adc = 'file';
      state.adcPath = adcPath;
    }
  }

  // A quota project recorded in the ADC file is what the client libraries bill
  // against, so it is the better guess than the CLI's own configuration.
  if (state.adc === 'file' && state.adcPath) {
    const quotaProject = await readQuotaProject(state.adcPath);
    if (quotaProject) state.project = quotaProject;
  }

  if (configDir) {
    const active = await readActiveConfig(configDir);
    if (active) {
      state.project ??= active.project;
      state.account = active.account;
    }
  }

  // The environment overrides gcloud's own configuration, as it does for the
  // connection Mora opens.
  const projectFromEnv = firstSet(
    env.GOOGLE_CLOUD_PROJECT,
    env.CLOUDSDK_CORE_PROJECT,
    env.GCLOUD_PROJECT,
  );
  if (projectFromEnv) state.project = projectFromEnv;

  return state;
}

/** The directory gcloud keeps its state in, or undefined when there is no home. */
function gcloudConfigDir(env: NodeJS.ProcessEnv): string | undefined {
  const override = env.CLOUDSDK_CONFIG?.trim();
  if (override) return override;

  if (process.platform === 'win32') {
    const appData = env.APPDATA?.trim();
    return appData ? path.join(appData, 'gcloud') : undefined;
  }

  const home = env.HOME?.trim() || homedir();
  return home ? path.join(home, '.config', 'gcloud') : undefined;
}

async function readQuotaProject(adcPath: string): Promise<string | undefined> {
  const parsed = await readJson(adcPath);
  if (!parsed) return undefined;
  const quotaProject = parsed.quota_project_id;
  return typeof quotaProject === 'string' && quotaProject.trim().length > 0
    ? quotaProject.trim()
    : undefined;
}

async function readJson(absolutePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(absolutePath, 'utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `[core]` of the configuration gcloud is currently using. The name lives in
 * `active_config`, and its settings in `configurations/config_<name>`.
 */
async function readActiveConfig(
  configDir: string,
): Promise<{ project?: string; account?: string } | undefined> {
  const name = (await readText(path.join(configDir, 'active_config')))?.trim() || 'default';
  const contents = await readText(path.join(configDir, 'configurations', `config_${name}`));
  if (!contents) return undefined;

  const core = readIniSection(contents, 'core');
  return { project: core.project, account: core.account };
}

async function readText(absolutePath: string): Promise<string | undefined> {
  try {
    return await readFile(absolutePath, 'utf8');
  } catch {
    return undefined;
  }
}

/** Keys of one `[section]` of gcloud's ini-style configuration file. */
function readIniSection(contents: string, section: string): Record<string, string> {
  const values: Record<string, string> = {};
  let inSection = false;

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;

    const header = /^\[(.+)]$/.exec(line);
    if (header) {
      inSection = header[1]?.trim() === section;
      continue;
    }
    if (!inSection) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length > 0 && value.length > 0) values[key] = value;
  }

  return values;
}

function firstSet(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

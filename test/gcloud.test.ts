import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADC_FILENAME, detectGcloud } from '../src/gcloud.js';

/** A gcloud config directory as the SDK would leave it. */
async function gcloudConfig(
  options: {
    adc?: Record<string, unknown>;
    activeConfig?: string;
    configs?: Record<string, string>;
  } = {},
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mora-gcloud-'));

  if (options.adc) {
    await writeFile(path.join(dir, ADC_FILENAME), JSON.stringify(options.adc), 'utf8');
  }
  if (options.activeConfig) {
    await writeFile(path.join(dir, 'active_config'), `${options.activeConfig}\n`, 'utf8');
  }
  if (options.configs) {
    await mkdir(path.join(dir, 'configurations'), { recursive: true });
    for (const [name, contents] of Object.entries(options.configs)) {
      await writeFile(path.join(dir, 'configurations', `config_${name}`), contents, 'utf8');
    }
  }

  return dir;
}

/** Only what detection is allowed to read, so the real machine cannot leak in. */
function env(dir: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { CLOUDSDK_CONFIG: dir, ...overrides };
}

describe('detectGcloud', () => {
  it('finds the credentials and project a signed-in user already has', async () => {
    const dir = await gcloudConfig({
      adc: { quota_project_id: 'acme-analytics', type: 'authorized_user' },
      configs: { default: '[core]\naccount = analyst@acme.com\nproject = acme-analytics\n' },
    });

    const state = await detectGcloud(env(dir));

    expect(state.adc).toBe('file');
    expect(state.adcPath).toBe(path.join(dir, ADC_FILENAME));
    expect(state.project).toBe('acme-analytics');
    expect(state.account).toBe('analyst@acme.com');
  });

  it('reads the configuration gcloud is actually using, not just the default one', async () => {
    const dir = await gcloudConfig({
      adc: { type: 'authorized_user' },
      activeConfig: 'work',
      configs: {
        default: '[core]\nproject = personal-sandbox\n',
        work: '[core]\naccount = analyst@acme.com\nproject = acme-prod\n',
      },
    });

    const state = await detectGcloud(env(dir));

    expect(state.project).toBe('acme-prod');
    expect(state.account).toBe('analyst@acme.com');
  });

  it('reports no credentials when the user has never logged in', async () => {
    const dir = await gcloudConfig();

    const state = await detectGcloud(env(dir));

    expect(state.adc).toBeNull();
    expect(state.project).toBeUndefined();
    expect(state.account).toBeUndefined();
  });

  it('prefers a key file named in the environment, as the client libraries do', async () => {
    const dir = await gcloudConfig({ adc: { type: 'authorized_user' } });
    const keyPath = path.join(dir, 'service-account.json');
    await writeFile(keyPath, '{}', 'utf8');

    const state = await detectGcloud(env(dir, { GOOGLE_APPLICATION_CREDENTIALS: keyPath }));

    expect(state.adc).toBe('environment');
    expect(state.adcPath).toBe(keyPath);
  });

  it('ignores a key file the environment names but that is not there', async () => {
    const dir = await gcloudConfig({ adc: { type: 'authorized_user' } });

    const state = await detectGcloud(
      env(dir, { GOOGLE_APPLICATION_CREDENTIALS: path.join(dir, 'missing.json') }),
    );

    expect(state.adc).toBe('file');
  });

  it('lets the environment override the project gcloud is configured with', async () => {
    const dir = await gcloudConfig({
      adc: { quota_project_id: 'acme-analytics' },
      configs: { default: '[core]\nproject = acme-analytics\n' },
    });

    const state = await detectGcloud(env(dir, { GOOGLE_CLOUD_PROJECT: 'from-shell' }));

    expect(state.project).toBe('from-shell');
  });

  it('survives a config file that is malformed or not JSON', async () => {
    const dir = await gcloudConfig({
      configs: { default: 'nonsense without a section\n[core\nproject' },
    });
    await writeFile(path.join(dir, ADC_FILENAME), 'not json at all', 'utf8');

    const state = await detectGcloud(env(dir));

    // The file exists, so the client libraries would still try to use it.
    expect(state.adc).toBe('file');
    expect(state.project).toBeUndefined();
    expect(state.account).toBeUndefined();
  });

  it('reads settings from [core] only', async () => {
    const dir = await gcloudConfig({
      configs: {
        default: '[compute]\nproject = wrong-one\n\n[core]\nproject = acme-prod\n# a comment\n',
      },
    });

    const state = await detectGcloud(env(dir));

    expect(state.project).toBe('acme-prod');
  });
});

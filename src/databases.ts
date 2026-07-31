export const DATABASE_IDS = ['duckdb', 'bigquery'] as const;

export type DatabaseId = (typeof DATABASE_IDS)[number];

export interface DatabaseInfo {
  id: DatabaseId;
  label: string;
  hint: string;
  /**
   * Whether opening it depends on a credential the reader has to supply. DuckDB
   * does not, so it is the one database `mora init` can bring up unattended.
   */
  needsCredentials: boolean;
  /**
   * A table path shaped the way this database's look, for the sample code in
   * the docs Mora writes. Illustrative only: Mora ships no data.
   */
  sampleTable: string;
}

export const DATABASES: Record<DatabaseId, DatabaseInfo> = {
  duckdb: {
    id: 'duckdb',
    label: 'DuckDB',
    hint: 'local files (CSV, Parquet, .duckdb) - no setup required',
    needsCredentials: false,
    sampleTable: 'data/orders.csv',
  },
  bigquery: {
    id: 'bigquery',
    label: 'BigQuery',
    hint: 'requires a GCP project and credentials',
    needsCredentials: true,
    sampleTable: 'analytics.orders',
  },
};

export function isDatabaseId(value: string): value is DatabaseId {
  return (DATABASE_IDS as readonly string[]).includes(value);
}

/** One setting of a connection, as it is asked for and as it is written. */
export interface ConnectionSetting {
  /** Key written under the connection in mora.yaml. */
  key: string;
  label: string;
  /** Long-form note written above the setting in mora.yaml. */
  comment?: string;
  /** Shown in the prompt as the shape of an answer. */
  placeholder?: string;
  /** Value used when the answer is empty. */
  defaultValue?: string;
  /**
   * A credential belongs in the environment, not in a committed file, so these
   * settings are offered as a `${VAR}` reference by default.
   */
  envVar?: string;
  /** Whether the connection is unusable without it. */
  required: boolean;
  /** CLI flag that supplies this setting unattended, without the leading `--`. */
  flag: string;
}

export interface SettingsContext {
  /** Models directory, the natural place for a DuckDB connection to read from. */
  modelsDir: string;
}

/**
 * What `mora connection add` asks for, per database. Declared here rather than in
 * the command so the prompts, the flags and the YAML that gets written cannot
 * drift apart.
 */
export function connectionSettings(id: DatabaseId, context: SettingsContext): ConnectionSetting[] {
  switch (id) {
    case 'duckdb':
      return [
        {
          key: 'database',
          label: 'Database file',
          comment: 'Point this at a .duckdb file to persist state between runs.',
          placeholder: ':memory:',
          defaultValue: ':memory:',
          required: true,
          flag: 'database',
        },
        {
          key: 'working_directory',
          label: 'Directory relative table paths resolve from',
          comment:
            'Relative paths inside `.table(...)` resolve from here.\n' +
            "Malloy Publisher resolves a package's table paths from the models\n" +
            'directory too, so a model written against it stays portable.',
          placeholder: context.modelsDir,
          defaultValue: context.modelsDir,
          required: true,
          flag: 'working-directory',
        },
      ];
    case 'bigquery':
      return [
        {
          key: 'project_id',
          label: 'GCP project id',
          comment: 'The project whose tables the models read.',
          envVar: 'GOOGLE_CLOUD_PROJECT',
          required: true,
          flag: 'project-id',
        },
        {
          key: 'location',
          label: 'Location',
          comment: 'Needed when the data lives outside the multi-region default.',
          placeholder: 'US',
          required: false,
          flag: 'location',
        },
        {
          key: 'service_account_key_path',
          label: 'Service account key file',
          comment:
            'Leave this out to use Application Default Credentials ' +
            '(`gcloud auth application-default login`).',
          envVar: 'GOOGLE_APPLICATION_CREDENTIALS',
          required: false,
          flag: 'service-account-key-path',
        },
        {
          key: 'billing_project_id',
          label: 'Billing project id',
          comment: 'Only needed when queries are billed to a different project.',
          required: false,
          flag: 'billing-project-id',
        },
      ];
  }
}

/**
 * What to write when nobody says otherwise. A setting with a conventional
 * environment variable is offered as a `${VAR}` reference, because mora.yaml is
 * committed and a credential written into it is a credential leaked.
 */
export function suggestSetting(setting: ConnectionSetting): string | undefined {
  if (setting.defaultValue !== undefined) return setting.defaultValue;
  if (setting.envVar && setting.required) return `\${${setting.envVar}}`;
  return undefined;
}

/** Suggested settings for a connection when nobody has answered yet. */
export function defaultConnectionSettings(
  id: DatabaseId,
  modelsDir: string,
): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const setting of connectionSettings(id, { modelsDir })) {
    const suggested = suggestSetting(setting);
    if (suggested !== undefined) settings[setting.key] = suggested;
  }
  return settings;
}

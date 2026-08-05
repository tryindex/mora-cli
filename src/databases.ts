export const DATABASE_IDS = ['duckdb', 'postgres', 'bigquery'] as const;

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
  postgres: {
    id: 'postgres',
    label: 'Postgres',
    hint: 'a host, a database and a password',
    needsCredentials: true,
    // Postgres has no default schema in Malloy, so every table path is
    // qualified. `public` is where an unqualified table actually lives.
    sampleTable: 'public.orders',
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

/** The types Mora can open, as prose: "duckdb, postgres and bigquery". */
export function listDatabases(): string {
  const ids = [...DATABASE_IDS];
  const last = ids.pop() as string;
  return ids.length === 0 ? last : `${ids.join(', ')} and ${last}`;
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
    case 'postgres':
      return [
        {
          key: 'host',
          label: 'Host',
          placeholder: 'localhost',
          defaultValue: 'localhost',
          required: true,
          flag: 'host',
        },
        {
          key: 'port',
          label: 'Port',
          placeholder: '5432',
          defaultValue: '5432',
          required: true,
          flag: 'port',
        },
        {
          key: 'database',
          label: 'Database name',
          comment: 'The database holding the tables the models read.',
          placeholder: 'postgres',
          defaultValue: 'postgres',
          required: true,
          flag: 'database',
        },
        {
          key: 'user',
          label: 'User',
          comment: 'Read-only is enough: Mora never writes to your database.',
          placeholder: 'postgres',
          defaultValue: 'postgres',
          required: true,
          flag: 'user',
        },
        {
          key: 'password',
          label: 'Password',
          comment:
            'Written as a reference so the value stays out of version control.\n' +
            'It is read when a connection opens, and never before.',
          envVar: 'POSTGRES_PASSWORD',
          required: true,
          flag: 'password',
        },
        {
          key: 'ssl',
          label: 'Require TLS (true or false)',
          comment:
            'Set this to true for a managed Postgres (Neon, Supabase, RDS),\n' +
            'which will refuse an unencrypted connection.',
          placeholder: 'false',
          required: false,
          flag: 'ssl',
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

export interface SettingFlag {
  /** Long flag, without the leading `--`. */
  flag: string;
  /** Help text, naming every database that uses it. */
  description: string;
}

/**
 * The flags that supply connection settings unattended, derived from the
 * registry so a new setting cannot arrive without one. Two databases can share a
 * flag — `--database` is a file to DuckDB and a database name to Postgres — and
 * the help text names both rather than whichever was declared first.
 */
export function settingFlags(ids: readonly DatabaseId[], context: SettingsContext): SettingFlag[] {
  const described = new Map<string, string[]>();
  for (const id of ids) {
    for (const setting of connectionSettings(id, context)) {
      const shared = described.get(setting.flag) ?? [];
      shared.push(`${DATABASES[id].label}: ${setting.label}`);
      described.set(setting.flag, shared);
    }
  }
  return [...described].map(([flag, labels]) => ({ flag, description: labels.join('; ') }));
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

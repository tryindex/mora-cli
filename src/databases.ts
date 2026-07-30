export const DATABASE_IDS = ['duckdb', 'bigquery'] as const;

export type DatabaseId = (typeof DATABASE_IDS)[number];

export interface DatabaseInfo {
  id: DatabaseId;
  label: string;
  hint: string;
  /**
   * DuckDB is the only connection Mora can bring up unattended, which is why
   * it is the default and the only one the scaffold can compile against.
   */
  needsCredentials: boolean;
}

export const DATABASES: Record<DatabaseId, DatabaseInfo> = {
  duckdb: {
    id: 'duckdb',
    label: 'DuckDB',
    hint: 'local files (CSV, Parquet, .duckdb) - no setup required',
    needsCredentials: false,
  },
  bigquery: {
    id: 'bigquery',
    label: 'BigQuery',
    hint: 'requires a GCP project and credentials',
    needsCredentials: true,
  },
};

export function isDatabaseId(value: string): value is DatabaseId {
  return (DATABASE_IDS as readonly string[]).includes(value);
}

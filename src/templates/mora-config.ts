import type { DatabaseId } from '../databases.js';

export interface MoraConfigOptions {
  projectName: string;
  modelsDir: string;
  dataDir: string;
  database: DatabaseId;
  duckdbConnectionName: string;
  warehouseConnectionName: string;
}

const WAREHOUSE_BLOCKS: Record<Exclude<DatabaseId, 'duckdb'>, (name: string) => string> = {
  bigquery: (name) => `${name}:
  type: bigquery
  project_id: my-gcp-project
  # Where Malloy may write temporary results.
  # dataset: malloy_temp
  # location: US
  # Omit to use Application Default Credentials (\`gcloud auth application-default login\`).
  # service_account_key_path: ./service-account.json`,

  postgres: (name) => `${name}:
  type: postgres
  host: localhost
  port: 5432
  database: analytics
  schema: public
  username: \${POSTGRES_USER}
  password: \${POSTGRES_PASSWORD}`,

  snowflake: (name) => `${name}:
  type: snowflake
  account: my-account
  warehouse: COMPUTE_WH
  database: ANALYTICS
  schema: PUBLIC
  username: \${SNOWFLAKE_USER}
  password: \${SNOWFLAKE_PASSWORD}`,
};

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

function commentOut(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `# ${line}` : '#'))
    .join('\n');
}

export function renderMoraConfig(options: MoraConfigOptions): string {
  const { projectName, modelsDir, dataDir, database, duckdbConnectionName } = options;
  const warehouseName = options.warehouseConnectionName;
  const defaultConnection = database === 'duckdb' ? duckdbConnectionName : warehouseName;

  const warehouseSections = (
    Object.keys(WAREHOUSE_BLOCKS) as (keyof typeof WAREHOUSE_BLOCKS)[]
  ).map((id) => {
    const block = WAREHOUSE_BLOCKS[id](warehouseName);
    const selected = id === database;
    const heading = selected
      ? `  # ${id}: fill in the values below before running queries.`
      : `  # ${id}: uncomment this block and set \`default\` above to \`${warehouseName}\`.`;
    const body = selected ? indent(block, 2) : indent(commentOut(block), 2);
    return `${heading}\n${body}`;
  });

  return `# Mora semantic layer configuration.
#
# Mora reads this file to know where your models live and how to connect to
# your data. Values written as \${VAR} are read from the environment, so
# credentials stay out of version control.

version: 1

project:
  name: ${projectName}
  # Directory Mora scans for .malloy model files.
  models: ${modelsDir}

connections:
  # Connection used by models that do not name one explicitly.
  default: ${defaultConnection}

  # DuckDB needs no credentials, so it works immediately. Point \`database\` at
  # a .duckdb file to persist state between runs.
  ${duckdbConnectionName}:
    type: duckdb
    database: ':memory:'
    # Relative paths inside ${duckdbConnectionName}.table('...') resolve from here.
    working_directory: ${dataDir}

${warehouseSections.join('\n\n')}
`;
}

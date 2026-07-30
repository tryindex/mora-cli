import type { DatabaseId } from '../databases.js';

export interface MoraConfigOptions {
  projectName: string;
  modelsDir: string;
  database: DatabaseId;
  duckdbConnectionName: string;
  warehouseConnectionName: string;
  /** Running Mora version, written as `cli_version` so upgrades can detect drift. */
  cliVersion: string;
}

const WAREHOUSE_BLOCKS: Record<Exclude<DatabaseId, 'duckdb'>, (name: string) => string> = {
  bigquery: (name) => `${name}:
  type: bigquery
  project_id: \${GOOGLE_CLOUD_PROJECT}
  # Set this when the data lives outside the multi-region default.
  # location: US
  # Credentials come from Application Default Credentials
  # (\`gcloud auth application-default login\`). To use a service account
  # instead, point this at its key file:
  # service_account_key_path: \${GOOGLE_APPLICATION_CREDENTIALS}`,
};

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

export function renderMoraConfig(options: MoraConfigOptions): string {
  const { projectName, modelsDir, database, duckdbConnectionName, cliVersion } = options;
  const warehouseName = options.warehouseConnectionName;
  const defaultConnection = database === 'duckdb' ? duckdbConnectionName : warehouseName;

  // Only the chosen warehouse is written. Adding a connection later is
  // `mora connection add`, which is less error-prone than uncommenting YAML and
  // cannot leave a half-edited block behind.
  const warehouseSection =
    database === 'duckdb'
      ? `  # Run \`mora connection add\` to point this project at a real warehouse.\n` +
        `  # Mora can open ${Object.keys(WAREHOUSE_BLOCKS).join(', ')} connections.`
      : `  # Fill in the values below before running queries.\n` +
        indent(WAREHOUSE_BLOCKS[database](warehouseName), 2);

  return `# Mora semantic layer configuration.
#
# Mora reads this file to know where your models live and how to connect to
# your data. Values written as \${VAR} are read from the environment, so
# credentials stay out of version control.

version: 1
# Written by Mora. Updated by \`mora upgrade\`; do not edit by hand.
cli_version: ${cliVersion}

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
    # This is the models directory, which is also what Malloy Publisher resolves
    # a package's table paths from, so models stay portable between the two.
    working_directory: ${modelsDir}

${warehouseSection}
`;
}

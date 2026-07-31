import {
  connectionSettings,
  DATABASES,
  type DatabaseId,
  type SettingsContext,
} from '../databases.js';

export interface MoraConfigOptions {
  projectName: string;
  modelsDir: string;
  database: DatabaseId;
  duckdbConnectionName: string;
  warehouseConnectionName: string;
  /**
   * Settings for the chosen warehouse, as they should appear in mora.yaml
   * (`${VAR}` references included). Ignored when the database is DuckDB.
   */
  warehouseSettings?: Record<string, string>;
  /** Running Mora version, written as `cli_version` so upgrades can detect drift. */
  cliVersion: string;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

/**
 * Renders a warehouse connection block from the settings the caller collected
 * and the registry's per-setting comments. Optional settings the caller skipped
 * stay as commented hints, so a teammate still sees what can be filled in later.
 */
export function renderWarehouseBlock(
  type: Exclude<DatabaseId, 'duckdb'>,
  name: string,
  settings: Record<string, string>,
  context: SettingsContext,
): string {
  const lines: string[] = [`${name}:`, `  type: ${type}`];

  for (const setting of connectionSettings(type, context)) {
    const value = settings[setting.key];
    if (value !== undefined) {
      if (setting.comment) lines.push(`  # ${setting.comment}`);
      lines.push(`  ${setting.key}: ${yamlScalar(value)}`);
      continue;
    }

    if (!setting.required) {
      if (setting.comment) lines.push(`  # ${setting.comment}`);
      const hint = setting.placeholder ?? (setting.envVar ? `\${${setting.envVar}}` : undefined);
      lines.push(hint !== undefined ? `  # ${setting.key}: ${hint}` : `  # ${setting.key}:`);
    }
  }

  return lines.join('\n');
}

/** Quote only when YAML would otherwise misread the value. */
function yamlScalar(value: string): string {
  if (value.length === 0) return "''";
  if (/^[\w./:${}@+-]+$/.test(value) && !/^[:\-?|&*!%@`']/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
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
        `  # Mora can open ${Object.keys(DATABASES)
          .filter((id) => id !== 'duckdb')
          .join(', ')} connections.`
      : `  # Filled in by \`mora init\`. Edit or re-run \`mora connection add\` to change.\n` +
        indent(
          renderWarehouseBlock(database, warehouseName, options.warehouseSettings ?? {}, {
            modelsDir,
          }),
          2,
        );

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

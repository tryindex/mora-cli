import { connectionSettings, type DatabaseId, type SettingsContext } from '../databases.js';

export interface ScaffoldConnection {
  /** Name models will use, as in `warehouse.table('...')`. */
  name: string;
  type: DatabaseId;
  /** Settings as they should appear in mora.yaml, `${VAR}` references included. */
  settings: Record<string, string>;
}

export interface MoraConfigOptions {
  projectName: string;
  modelsDir: string;
  /** The one connection `mora init` declares. Others are added later. */
  connection: ScaffoldConnection;
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
 * Renders a connection block from the settings the caller collected and the
 * registry's per-setting comments. Optional settings the caller skipped stay as
 * commented hints, so a teammate still sees what can be filled in later.
 */
export function renderConnectionBlock(
  type: DatabaseId,
  name: string,
  settings: Record<string, string>,
  context: SettingsContext,
): string {
  const lines: string[] = [`${name}:`, `  type: ${type}`];

  for (const setting of connectionSettings(type, context)) {
    const comment = setting.comment
      ?.split('\n')
      .map((line) => `  # ${line}`)
      .join('\n');
    const value = settings[setting.key];
    if (value !== undefined) {
      if (comment) lines.push(comment);
      lines.push(`  ${setting.key}: ${yamlScalar(value)}`);
      continue;
    }

    if (!setting.required) {
      if (comment) lines.push(comment);
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
  const { projectName, modelsDir, connection, cliVersion } = options;

  // Exactly one connection, the one the reader asked for. A second is
  // `mora connection add`, which is less error-prone than uncommenting YAML and
  // cannot leave a half-edited block behind.
  const block = indent(
    renderConnectionBlock(connection.type, connection.name, connection.settings, { modelsDir }),
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
  # Connection used by models that do not name one explicitly.
  default_connection: ${connection.name}

# Add another with \`mora connection add\`, which edits this file in place.
connections:
${block}
`;
}

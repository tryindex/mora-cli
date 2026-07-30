export interface EnvOptions {
  projectName: string;
  /** Variable names the project's connections reference. */
  variables: readonly string[];
}

export function renderEnvExample({ projectName, variables }: EnvOptions): string {
  return `# Credentials for the ${projectName} semantic layer.
#
# This file is committed on purpose: it records which variables Mora needs
# without recording their values. Never put a real credential here.
#
# Your own values belong in .env, which is gitignored. Running \`mora init\` in a
# checkout that is already set up copies this file to .env for you and reports
# which variables are still empty.

${assignments(variables)}
`;
}

export function renderEnvFile({ projectName, variables }: EnvOptions): string {
  return `# Local credentials for the ${projectName} semantic layer.
#
# This file is gitignored. Fill in the values below, then run \`mora validate\`.

${assignments(variables)}
`;
}

function assignments(variables: readonly string[]): string {
  return variables.map((name) => `${name}=`).join('\n');
}

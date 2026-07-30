export interface PublisherOptions {
  projectName: string;
  /** Models directory, relative to the project root, with forward slashes. */
  modelsDir: string;
}

export const PUBLISHER_MANIFEST_FILENAME = 'publisher.json';
export const PUBLISHER_CONFIG_FILENAME = 'publisher.config.json';

/**
 * The manifest that makes the models directory a Malloy Publisher package.
 * Mora builds and reviews the semantic layer; Publisher serves it over REST and
 * MCP. Writing this here means a merged Mora project is servable as-is instead
 * of needing a second, hand-maintained description of the same models.
 */
export function renderPublisherManifest(options: PublisherOptions): string {
  return json({
    name: packageName(options.projectName),
    version: '0.0.1',
    description: `${options.projectName} semantic layer, maintained with Mora.`,
  });
}

/**
 * The server-side config listing this package. Publisher only serves packages a
 * config names, and it looks for this file in the directory it is started from.
 */
export function renderPublisherConfig(options: PublisherOptions): string {
  return json({
    // Left open so the Publisher UI can add connections while a team is finding
    // its feet. Set it to true before exposing a server beyond one machine.
    frozenConfig: false,
    environments: [
      {
        name: 'default',
        packages: [
          {
            name: packageName(options.projectName),
            location: `./${options.modelsDir}`,
          },
        ],
      },
    ],
  });
}

/**
 * A project name is prose ("Retail Analytics"); a package name is an identifier
 * that appears in URLs and MCP tool arguments.
 */
export function packageName(projectName: string): string {
  const slug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'semantic-layer';
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

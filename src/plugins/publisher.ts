import {
  PUBLISHER_CONFIG_FILENAME,
  PUBLISHER_MANIFEST_FILENAME,
  renderPublisherConfig,
  renderPublisherManifest,
} from '../templates/publisher.js';
import type { MoraPlugin } from './types.js';

/**
 * Makes a project servable by Malloy Publisher. Mora is the authoring half of a
 * semantic layer and Publisher is the serving half, so this is an integration a
 * team opts into rather than something every project carries.
 */
export const publisherPlugin: MoraPlugin = {
  name: 'publisher',
  description: 'Serve these models over REST and MCP with Malloy Publisher',

  setup({ projectName, modelsDir }) {
    const options = { projectName, modelsDir };
    return {
      // Scaffolded once and then the team's, like mora.yaml: a Publisher config
      // grows warehouse connections and access rules Mora must not clobber.
      files: [
        {
          path: `${modelsDir}/${PUBLISHER_MANIFEST_FILENAME}`,
          strategy: 'replace',
          contents: renderPublisherManifest(options),
        },
        {
          path: PUBLISHER_CONFIG_FILENAME,
          strategy: 'replace',
          contents: renderPublisherConfig(options),
        },
      ],
      // Publisher's persisted state and its copies of served packages. The
      // config that produces them is committed; these are per-machine.
      gitignore: ['publisher.db', 'publisher.db.wal', 'publisher_data/'],
      nextSteps: [
        'Start a server with `npx @malloy-publisher/server --server_root .`.',
        `Add the warehouse connections a served model needs to ${PUBLISHER_CONFIG_FILENAME}. ` +
          'Publisher keeps its own connection config, so it can read from a different ' +
          'warehouse than your laptop does.',
        'Commit both files so the whole team serves the same package.',
      ],
    };
  },

  agentsNote({ modelsDir }) {
    return (
      `- \`${modelsDir}/${PUBLISHER_MANIFEST_FILENAME}\` and \`${PUBLISHER_CONFIG_FILENAME}\` - let Malloy\n` +
      '  Publisher serve these models. Not used by the `mora` commands.'
    );
  },
};

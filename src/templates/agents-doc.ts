export interface AgentsDocOptions {
  projectName: string;
  modelsDir: string;
  dataDir: string;
  exampleModelPath: string;
  hasExample: boolean;
  /** Where Mora keeps the docs it owns, e.g. `.agents`. */
  agentDocsDir: string;
}

export interface AgentsDoc {
  /** Heading and framing: written once, then the project's to edit. */
  title: string;
  /** The part Mora maintains. */
  managed: string;
  /** Where a team records its own rules. Written once, never rewritten. */
  teamSection: string;
}

export function renderAgentsDoc(options: AgentsDocOptions): AgentsDoc {
  return {
    title: renderTitle(options),
    managed: renderManaged(options),
    teamSection: TEAM_SECTION,
  };
}

function renderTitle({ projectName }: AgentsDocOptions): string {
  return `# Working with the ${projectName} semantic layer

This project uses [Mora](https://github.com/tryindex/mora-cli) to define a semantic
layer in [Malloy](https://malloydata.dev). Read this before answering any
question about the data.
`;
}

const TEAM_SECTION = `## Team conventions

Mora never edits this section, so conventions written here survive upgrades.
Worth recording: which sources are canonical, how measures should be named, and
who to ask before changing one that is already in use.
`;

function renderManaged(options: AgentsDocOptions): string {
  const { modelsDir, dataDir, exampleModelPath, hasExample, agentDocsDir } = options;

  const layout = [
    '- `mora.yaml` - project config: model directory and database connections.',
    `- \`${modelsDir}/\` - Malloy models. This is the semantic layer.`,
    ...(hasExample
      ? [
          `- \`${exampleModelPath}\` - worked example: one source with dimensions, measures and views.`,
          `- \`${dataDir}/\` - sample data backing the example model.`,
        ]
      : []),
    `- \`${agentDocsDir}/malloy.md\` - how to write Malloy in this project.`,
    `- \`${agentDocsDir}/mora.md\` - the \`mora\` commands, their flags and output.`,
  ].join('\n');

  return `Mora maintains this section, between its \`mora:begin\`/\`mora:end\` markers.
Anything written outside it is preserved, so project-specific rules belong under
"Team conventions" at the end of this file rather than here.

## Why this exists

Hand-written SQL cannot be trusted without review: every query re-derives what
"revenue" or "active customer" means, and nobody notices when two answers
disagree. The semantic layer moves those definitions into version-controlled
model files. Queries then compose vetted measures instead of restating logic,
so an answer is reviewable by reading a few lines of Malloy.

## Rules

1. Answer data questions by composing the dimensions, measures and views that
   already exist. Run \`mora describe\` first to see them.
2. If a question needs a concept the model does not have, add it to a model in
   \`${modelsDir}/\` as a named dimension, measure or view, then query it. Do not
   inline the logic into a one-off query and leave it there.
3. Never bypass the semantic layer with raw SQL against the warehouse. If you
   believe raw SQL is unavoidable, say so and explain why.
4. After editing any \`.malloy\` file, run \`mora validate\` before reporting
   results.
5. Definitions are shared. Changing an existing measure changes every answer
   that uses it, so prefer adding a new one over redefining.
6. Report the SQL or the definitions behind every number, so a human can audit
   how the answer was produced.

## Required reading

These two files are Mora's own reference. They are kept current by the CLI, so
read them rather than guessing:

- Read \`${agentDocsDir}/malloy.md\` before editing a \`.malloy\` file.
- Read \`${agentDocsDir}/mora.md\` before running a \`mora\` command.

## Layout

${layout}
`;
}

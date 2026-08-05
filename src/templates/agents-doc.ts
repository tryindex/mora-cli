export interface AgentsDocOptions {
  projectName: string;
  modelsDir: string;
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
    teamSection: renderTeamSection(options),
  };
}

function renderTitle({ projectName }: AgentsDocOptions): string {
  return `# Working with the ${projectName} semantic layer

This project uses [Mora](https://github.com/mora/mora-cli) to define a semantic
layer in [Malloy](https://malloydata.dev). Read this before answering any
question about the data.
`;
}

function renderTeamSection({ modelsDir }: AgentsDocOptions): string {
  return `## Team conventions

Mora never edits this section, so conventions written here are yours to keep.
This is the place for rules about working in this repo. Rules about what a
metric means — canonical sources, naming, the calendar, standard exclusions, who
approves a definition — go in \`${modelsDir}/conventions.md\` instead, which is
the file an agent reads before it proposes one.
`;
}

function renderManaged(options: AgentsDocOptions): string {
  const { modelsDir, agentDocsDir } = options;

  const layout = [
    '- `mora.yaml` - project config: model directory and database connections.',
    `- \`${modelsDir}/\` - Malloy models. This is the semantic layer.`,
    `- \`${modelsDir}/conventions.md\` - the team's own rules for what a metric means.`,
    `- \`${agentDocsDir}/modeling.md\` - how to turn a warehouse table into reviewed definitions.`,
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

That only holds if the definitions were reviewed. A measure you wrote and
nobody read is worth no more than the SQL it replaced, which is why the work
below ends in a pull request rather than in an answer.

## The loop

1. **Read the models in \`${modelsDir}/\`** before answering anything. They are
   the vocabulary: the dimensions, measures, views and named queries someone
   agreed on. Reuse before adding.
2. **Answer with what is there**, by name: \`mora query <name>\`. Report the SQL
   it prints alongside the number, so a human can audit how you got it.
3. **When the vocabulary is missing a concept**, agree what it means before
   defining it: read \`${modelsDir}/conventions.md\`, then ask the questions in
   \`${agentDocsDir}/modeling.md\` about anything it does not answer. Then add it
   to a model as a named dimension, measure or view with a \`#"\` doc string, run
   \`mora validate\`, and query it by name. Never inline the logic into a one-off
   query and leave it there.
4. **When the question is about a table no model covers**, this is a modelling
   job, not a query: read \`${agentDocsDir}/modeling.md\` and follow it. It
   starts at \`mora schema\` and ends at a pull request, with a human agreeing
   the scope in the middle.
5. **Open a pull request** for anything you added. Say plainly that the
   definitions are proposed until someone reviews them.

## Rules

1. Never bypass the semantic layer with raw SQL against the warehouse. If you
   believe raw SQL is unavoidable, say so and explain why.
2. \`mora query -f\` and \`-e\` run Malloy nobody has reviewed. Use them to check
   what is true of the data, not to answer a question and move on: anything
   worth keeping becomes a named definition first.
3. After editing any \`.malloy\` file, run \`mora validate\` before reporting
   results. It compiles against the database, so a pass means the columns
   really exist.
4. Definitions are shared. Changing an existing measure changes every answer
   that uses it, so prefer adding a new one over redefining.
5. Never guess at what data means. A column called \`total\` may or may not
   include tax, and only a query can settle it.
6. Never decide what a metric means. What counts as revenue is the team's to
   say, so ask before defining one and write the answer into its doc string.
7. Report the SQL or the definitions behind every number, so a human can audit
   how the answer was produced.

## Required reading

These files are Mora's own reference. They are kept current by the CLI, so read
them rather than guessing:

- Read \`${agentDocsDir}/modeling.md\` before proposing a model for a table the
  semantic layer does not cover yet.
- Read \`${agentDocsDir}/malloy.md\` before editing a \`.malloy\` file.
- Read \`${agentDocsDir}/mora.md\` before running a \`mora\` command.

\`${modelsDir}/conventions.md\` is not Mora's — it is this team's answers about
what a metric means. Read it before adding any definition, and add to it
whatever you learn that will be true of the next one too.

## Layout

${layout}
`;
}

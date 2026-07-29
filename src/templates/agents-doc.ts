export interface AgentsDocOptions {
  projectName: string;
  modelsDir: string;
  dataDir: string;
  exampleModelPath: string;
  connectionName: string;
  hasExample: boolean;
}

export function renderAgentsDoc(options: AgentsDocOptions): string {
  const { projectName, modelsDir, dataDir, exampleModelPath, connectionName, hasExample } = options;

  const layout = hasExample
    ? `- \`mora.yaml\` - project config: model directory and database connections.
- \`${modelsDir}/\` - Malloy models. This is the semantic layer.
- \`${exampleModelPath}\` - worked example: one source with dimensions, measures and views.
- \`${dataDir}/\` - sample data backing the example model.`
    : `- \`mora.yaml\` - project config: model directory and database connections.
- \`${modelsDir}/\` - Malloy models. This is the semantic layer.`;

  return `# Working with the ${projectName} semantic layer

This project uses [Mora](https://github.com/tryindex/mora-cli) to define a semantic
layer in [Malloy](https://malloydata.dev). Read this before answering any
question about the data.

## Why this exists

Hand-written SQL cannot be trusted without review: every query re-derives what
"revenue" or "active customer" means, and nobody notices when two answers
disagree. The semantic layer moves those definitions into version-controlled
model files. Queries then compose vetted measures instead of restating logic,
so an answer is reviewable by reading a few lines of Malloy.

## Rules

1. Answer data questions by composing the dimensions, measures and views that
   already exist in \`${modelsDir}/\`. Read the model files first.
2. If a question needs a concept the model does not have, add it to the model
   as a named dimension, measure or view, then query it. Do not inline the
   logic into a one-off query.
3. Never bypass the semantic layer with raw SQL against the warehouse. If you
   believe raw SQL is unavoidable, say so and explain why.
4. After editing any \`.malloy\` file, verify it compiles before reporting
   results.
5. Definitions are shared. Changing an existing measure changes every answer
   that uses it, so prefer adding a new one over redefining.

## Layout

${layout}

## Malloy in one page

\`\`\`malloy
// A source wraps a table and attaches meaning to it.
source: orders is ${connectionName}.table('orders.csv') extend {
  primary_key: id

  // Dimensions: row-level attributes to group by or filter on.
  dimension:
    ordered_at is order_date::date
    is_large_order is amount > 500

  // Measures: aggregations, defined once and reused everywhere.
  measure:
    order_count is count()
    revenue is amount.sum()

  // Views: named, reusable query shapes.
  view: revenue_by_month is {
    group_by: ordered_at.month
    aggregate: revenue, order_count
  }
}

// Joins connect sources so measures can be sliced by related attributes.
source: order_facts is orders extend {
  join_one: customers with customer_id
}

// A named query is an entry point. Prefer these over ad-hoc queries.
query: monthly_revenue is orders -> revenue_by_month

// An ad-hoc query composes existing definitions rather than restating them.
run: orders -> {
  where: status = 'completed'
  group_by: region
  aggregate: revenue
  order_by: revenue desc
  limit: 10
}
\`\`\`

Things worth remembering:

- \`count(expr)\` counts distinct values of \`expr\`; \`count()\` counts rows.
- Filters attach with \`where:\`, and can be scoped to a single measure:
  \`measure: completed_revenue is amount.sum() { where: status = 'completed' }\`.
- Nest a view inside another with \`nest:\` to get a breakdown per group.
- Time truncation reads as \`ordered_at.month\`, \`ordered_at.year\`, and so on.

## Workflow for extending the model

1. Read the relevant file in \`${modelsDir}/\` to see what already exists.
2. Add the dimension, measure or view next to related definitions, with a name
   a domain expert would recognize.
3. Confirm the model still compiles.
4. Run the query and report the answer together with the definitions it used,
   so a human can check the logic rather than just the number.

## Commands

- \`mora init\` - scaffold a semantic layer project. Non-interactive when given
  \`--yes\`; add \`--json\` for machine-readable output. Run \`mora init --help\`
  for the full flag list.

Query execution (\`mora query\`) and standalone validation (\`mora validate\`) are
not implemented yet. Until they land, use the Malloy tooling directly to check
models, and note in your answer that results were not produced through Mora.
`;
}

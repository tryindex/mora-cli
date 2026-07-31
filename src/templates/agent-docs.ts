export interface AgentDocsOptions {
  modelsDir: string;
  /** Connection the example model reads from, used in the sample code. */
  connectionName: string;
}

/**
 * The Malloy reference. It lives outside AGENTS.md so it is loaded when an agent
 * is about to write a model, rather than on every request.
 */
export function renderMalloyGuide({ connectionName, modelsDir }: AgentDocsOptions): string {
  return `# Malloy for Mora projects

Mora maintains this file. Anything written here is replaced on upgrade, so put
project-specific notes in AGENTS.md under "Team conventions" instead.

Read this before editing a \`.malloy\` file in \`${modelsDir}/\`.

## The shape of a model

\`\`\`malloy
// A source wraps a table and attaches meaning to it.
#" One row per order, with the customer who placed it.
source: orders is ${connectionName}.table('data/orders.csv') extend {
  primary_key: id

  // Dimensions: row-level attributes to group by or filter on.
  dimension:
    #" Date the order was placed.
    ordered_at is order_date::date
    #" An order over $500. The threshold is a business convention.
    is_large_order is amount > 500

  // Measures: aggregations, defined once and reused everywhere.
  measure:
    #" Number of orders.
    order_count is count()
    #" Total order amount, including orders not yet completed.
    revenue is amount.sum()

  // Views: named, reusable query shapes.
  #" Revenue and order count for each month.
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

## Things worth remembering

- \`count(expr)\` counts distinct values of \`expr\`; \`count()\` counts rows.
- Filters attach with \`where:\`, and can be scoped to a single measure:
  \`measure: completed_revenue is amount.sum() { where: status = 'completed' }\`.
- Nest a view inside another with \`nest:\` to get a breakdown per group.
- Time truncation reads as \`ordered_at.month\`, \`ordered_at.year\`, and so on.
- A view is queried through its source (\`orders -> revenue_by_month\`); a
  \`query:\` declaration is already a complete query and runs on its own.
- The name before \`.table(...)\` is a connection declared in \`mora.yaml\`, and a
  project can have several. Run \`mora connection list\` to see which ones exist
  before writing a source against a table you have not read from yet.

## Doc strings

A line beginning with \`#"\` above a definition is its description. Unlike a
\`//\` comment it is part of the model: \`mora describe\` prints it, matches search
patterns against it, and a served model hands it to whoever is asking. It is how
a definition explains itself to a reader who was not in the room when it was
agreed, so it is the difference between a name someone trusts and a name someone
re-derives by hand.

\`\`\`malloy
#" Revenue from completed orders only. Excludes refunds and pending payments,
#" so it is lower than \`revenue\` and is the figure finance reports.
measure: completed_revenue is amount.sum() { where: status = 'completed' }
\`\`\`

Write what the number means and what it leaves out, not what the expression
already says: "total order amount, before refunds" earns its place, "sums the
amount column" does not. Consecutive \`#"\` lines form one description.

A \`query:\` that only runs a view inherits that view's description, so give it a
doc string of its own only when it adds something the view does not say.

## Naming

A definition is read by people who did not write it, so name it the way a domain
expert would say it out loud: \`revenue\`, \`active_customers\`,
\`completed_revenue_by_month\`. Avoid restating the aggregation in the name
(\`sum_of_amount\`) and avoid abbreviations that only make sense in one team.

## Extending a model

1. Run \`mora describe\` to see what already exists. Reuse before adding.
2. Read the file in \`${modelsDir}/\` you are about to change.
3. Add the dimension, measure or view next to related definitions, with a \`#"\`
   doc string on every new definition.
4. Run \`mora validate\`. Because Malloy resolves table schemas while compiling,
   a pass means the model parses *and* the referenced columns really exist.
5. Run the query with \`mora query\` and report the answer together with the
   definitions it used, so a human can check the logic and not just the number.

## Changing something that already exists

Definitions are shared. Editing a measure changes every answer that uses it,
including ones already in dashboards and documents. Prefer adding a new
definition next to the old one. If a change really is a correction, say so
plainly in your answer, and name what else depends on it.
`;
}

/** The command reference: what to run, what comes back, and what it means. */
export function renderMoraGuide({ modelsDir }: AgentDocsOptions): string {
  return `# The mora command line

Mora maintains this file. Anything written here is replaced on upgrade, so put
project-specific notes in AGENTS.md under "Team conventions" instead.

Read this before running a \`mora\` command.

Every command accepts \`--json\` for a machine-readable report instead of prose,
and runs against the current directory unless told otherwise: \`init\` and
\`validate\` take the project directory as their argument, while \`describe\`,
\`query\` and \`connection\` take it as \`-C <dir>\`, because their own argument is
a name. Exit codes are the same everywhere: \`0\` success, \`1\` failure, \`2\` bad
usage, \`3\` refused because files already exist.

## mora describe [pattern]

Lists the vocabulary: every source in \`${modelsDir}/\` with its dimensions,
measures, views and joins, each with its doc string, plus the named queries that
can be run directly. Start here, before writing any query, so an answer reuses a
definition someone reviewed instead of inventing one.

An optional \`pattern\` filters by name *and* by doc string, case-insensitively,
keeping the source each match belongs to. Search the words a question uses, not
just the identifier you expect:

\`\`\`bash
mora describe              # the whole vocabulary
mora describe revenue      # matches on name or description
mora describe refund       # finds a measure documented as excluding refunds
\`\`\`

\`--json\` reports
\`{ ok, command: 'describe', pattern, sources, queries, summary }\`, where each
source carries \`{ name, model, description, dimensions, measures, views, joins }\`
and each entry within those carries \`{ name, type, description }\`. Report the
description of any definition you use, so the reader gets its caveats too.

## mora query <name> | -e "<malloy>"

Runs a query and prints the rows with the SQL that produced them.

\`\`\`bash
mora query monthly_revenue              # a query: declaration
mora query orders.revenue_by_month      # a view, as source.view
mora query revenue_by_month             # unambiguous view names resolve alone
mora query -e "orders -> { aggregate: revenue }"
\`\`\`

Flags:

- \`-e, --expr <malloy>\` runs Malloy that is not in the model. The result is
  marked \`reviewed: false\`, because nobody has reviewed that logic. Use it to
  explore, then promote anything worth keeping to a named view or query and run
  it by name.
- \`--sql\` prints the generated SQL and runs nothing. Useful for checking what a
  definition compiles to before executing it.
- \`--limit <n>\` caps the rows returned. Keep it small: rows land in your
  context.

\`--json\` reports \`{ ok, command: 'query', name, reviewed, model, sql, executed,
rows, rowCount, truncated, nextSteps }\`. \`executed\` is false under \`--sql\`, so
an empty \`rows\` is never mistaken for a query that matched nothing. An unknown
name exits \`1\` with code \`unknown-definition\` and lists what does exist.

Always include the SQL, or the definitions used, alongside a number you report.
An answer nobody can audit is not worth much.

## mora validate

Compiles every model in \`${modelsDir}/\`. Run it after any edit to a \`.malloy\`
file, and before opening a pull request. \`--json\` lists each model with its
sources, named queries and any compile error.

## mora connection list | test [name] | add [name]

A model reads from a named connection: \`warehouse.table('analytics.sessions')\`.
Run \`mora connection list\` when a model needs a table that is not in the
connection you have been using — it shows every connection the project declares,
which one is the default, and which credentials are unset. If a query fails for a
reason that looks like access rather than logic, \`mora connection test\` says
whether the database is answering at all.

\`mora connection add\` declares a new one. Give it \`--type\`, plus any required
setting that has no sensible default, and it will not need to prompt:

\`\`\`bash
mora connection add warehouse --type bigquery --project-id '\${GOOGLE_CLOUD_PROJECT}' --json
mora connection add exports --type duckdb --database exports.duckdb --yes
\`\`\`

Write a credential as \`\${VAR}\`, never as a literal: \`mora.yaml\` is committed.
The command records the variable in \`.env.example\` and reports it under
\`missingEnvVars\` if it is unset; the value itself belongs in \`.env\`, which only
the person running it can write. Adding a connection does not make it usable by a
Publisher server, which keeps its own config.

BigQuery uses Application Default Credentials when \`service_account_key_path\` is
unset, so a \`test\` that fails on a keyless connection usually means
\`gcloud auth application-default login\` has not been run for an account with
access. Ask the person you are working with to run it; it needs a browser, so you
cannot do it for them. Run without \`--project-id\`, a human is also shown a
searchable list of the projects their credentials can query — which is why an
unattended run must pass the project explicitly rather than expect a default.

## mora upgrade

Brings this project up to date with the running Mora: refreshes \`.agents/\` and
the managed block in \`AGENTS.md\`, applies any \`mora.yaml\` migrations, and
stamps \`cli_version\`. Run it after updating the CLI, then commit the diff so the
team upgrades together.

\`\`\`bash
mora upgrade              # apply
mora upgrade --check      # report only; exit 1 when pending
mora upgrade --json
\`\`\`

A project stamped by a *newer* Mora refuses to run upgrade on an older CLI —
update the binary first. A missing stamp is treated as pending.

## mora init

Two modes. In a directory without \`mora.yaml\`, init scaffolds a new semantic
layer. Pass \`--db\` and any required warehouse setting as a flag so it does not
need to prompt; for BigQuery that is usually \`--project-id '\${GOOGLE_CLOUD_PROJECT}'\`.
Init writes credential values into \`.env\` when you answer interactively, and
tests the warehouse unless you pass \`--no-test\`.

In a project that already has \`mora.yaml\`, this is a setup run: it creates a
local \`.env\` from \`.env.example\`, reports which credentials are unset, notes
when \`mora upgrade\` (or a newer CLI) is needed, and compiles the models. It does
not touch models, configuration, or Mora-owned docs — those are \`mora upgrade\`'s
job. Run it after cloning.
`;
}

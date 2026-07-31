export interface AgentDocsOptions {
  modelsDir: string;
  /** The project's default connection, so sample code names a real one. */
  connectionName: string;
  /**
   * A table path shaped the way the project's database writes them. The sample
   * code is illustrative: Mora ships no data, and this table does not exist.
   */
  sampleTablePath: string;
}

/**
 * The Malloy reference. It lives outside AGENTS.md so it is loaded when an agent
 * is about to write a model, rather than on every request.
 */
export function renderMalloyGuide({
  connectionName,
  modelsDir,
  sampleTablePath,
}: AgentDocsOptions): string {
  return `# Malloy for Mora projects

Mora maintains this file. Anything written here is replaced on upgrade, so put
project-specific notes in AGENTS.md under "Team conventions" instead.

Read this before editing a \`.malloy\` file in \`${modelsDir}/\`.

## The shape of a model

The table below is an illustration, not a table this project has. Run
\`mora schema\` for the real ones.

\`\`\`malloy
// A source wraps a table and attaches meaning to it.
#" One row per order, with the customer who placed it.
source: orders is ${connectionName}.table('${sampleTablePath}') extend {
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

/**
 * How to turn a warehouse nobody has modelled yet into a first semantic layer.
 * Separate from the Malloy reference because it answers a different question:
 * that one is "how do I write this", this one is "what should I write at all".
 */
export function renderModelingGuide({
  connectionName,
  modelsDir,
  sampleTablePath,
}: AgentDocsOptions): string {
  return `# Proposing a semantic layer

Mora maintains this file. Anything written here is replaced on upgrade, so put
project-specific notes in AGENTS.md under "Team conventions" instead.

Read this when the warehouse has tables that \`${modelsDir}/\` does not cover yet.
For adding a measure to a source that already exists, \`.agents/malloy.md\` is the
guide you want; this one is about proposing sources that do not exist.

## When this applies

\`mora describe\` came back empty or thin, and the question you were asked is
about data the semantic layer does not describe. Check the connection works
first (\`mora connection test\`): everything below reads the database, and a
credential problem reported as a modelling problem wastes the reader's time.

## 1. Discover, without saying anything yet

Do this whole step before proposing anything. The point is to know the data
before offering an opinion about it.

\`\`\`bash
mora schema --json                       # every table this connection can read
mora schema orders customers --json      # columns and types, several at once
\`\`\`

Run the listing first. It is where valid table names come from, so no name ever
has to be guessed, and every name it prints goes inside
\`${connectionName}.table('...')\` unchanged.

Then query the data. Nothing is modelled yet, so declare a throwaway source in
the expression itself and run against that. \`mora query -e\` takes a whole
document, so the source and the query travel together and no file is touched:

\`\`\`bash
mora query -e "source: probe is ${connectionName}.table('${sampleTablePath}') extend {}
run: probe -> { aggregate: rows is count() }"
\`\`\`

**Never infer meaning from a column name. Query the data.** A column called
\`total\` may or may not include tax. A \`status\` column may have five values or
five hundred. A foreign key may point at rows that are not there. Names suggest;
only the data decides. Use \`mora query -e\` for each of these:

| What to establish | Why it changes the model |
| --- | --- |
| Duplicate keys: \`group_by\` the key, \`aggregate: count()\`, \`having: count() > 1\` | Duplicates make every \`sum()\` wrong, and silently. |
| Join cardinality: is the foreign key unique on the other side? | Decides \`join_one\` against \`join_many\`. Guessing double-counts. |
| Null rates per column | A column that is mostly null is not a dimension worth offering. |
| Distinct values of each categorical | Five statuses group well; five hundred do not. |
| Distributions (min, max, percentiles) of key numbers | Tier boundaries come from the data, not from round numbers. |
| Related money columns, compared | Whether \`total\` is \`subtotal + tax\` decides which one revenue means. |
| Candidate date columns, compared | Which timestamp is the canonical one to report on. |

Keeping the same \`probe\` declaration at the top, the two that matter most read
like this:

\`\`\`bash
# Is the key unique? Anything but zero means sum() cannot be trusted.
mora query -e "source: probe is ${connectionName}.table('${sampleTablePath}') extend {}
run: probe -> { group_by: id; aggregate: rows is count() } -> { where: rows > 1; aggregate: duplicate_keys is count() }"

# How many rows, and how many distinct values of the key you would join on.
mora query -e "source: probe is ${connectionName}.table('${sampleTablePath}') extend {}
run: probe -> { aggregate: rows is count(), customers is count(customer_id) }"
\`\`\`

Every one of these is marked \`reviewed: false\`, which is correct: they are
throwaway checks, not definitions. Nothing here belongs in the model as written.

Also worth knowing before you propose: how large each table is, and which tables
are operational rather than analytical. A staging, audit or ETL table is not
part of a semantic layer.

## 2. Propose a scope, then stop

Say what you found and what you would model, and let a human choose. Do not
start writing files.

Classify each table:

- **Fact** - the events being measured: orders, sessions, payments.
- **Dimension** - the entities to slice by: customers, products, regions.
- **Bridge** - many-to-many links: order_items, tags.
- **Skip** - staging, audit, ETL, or pre-aggregated snapshots. Say why.

Then offer two or three lettered options, each one analytical domain, with the
tables it covers, the questions it answers, and row counts you measured. Mark
one as your recommendation and give the reason.

**Modelling every table is the wrong answer.** A first pull request that covers
one domain well can be reviewed; one that covers twenty cannot, and an
unreviewed definition is worth no more than the ad-hoc SQL it replaced.

## 3. Write the models

Once a human has picked a scope, write it into \`${modelsDir}/\`. Read
\`.agents/malloy.md\` first for the syntax and the doc string conventions; the
rules specific to a first draft are these:

- One file per base source, named for the table it wraps.
- \`primary_key\` on anything that has one, from the key you verified is unique.
- Joins only where you checked the cardinality, using the relationship the data
  showed rather than the one the column names imply.
- A few measures that answer the questions from the scope you agreed. Resist
  adding every aggregate that is possible.
- A \`#"\` doc string on every definition, saying what it means and what it
  leaves out. A measure whose caveats are undocumented invites someone to
  re-derive it, which is the problem the semantic layer exists to solve.
- Where the data surprised you, say so in the doc string. "Excludes the 3% of
  rows with a null region" is exactly the kind of thing that must not live only
  in your answer.

## 4. Validate, then hand it over

\`\`\`bash
mora validate                     # compiling proves the columns really exist
mora query orders.revenue_by_month
\`\`\`

Spot-check each measure against something known before reporting anything. Then
commit and open a pull request.

This last part is not a formality. Until a human reviews them, these definitions
are *proposed*: they carry no more authority than the queries they replace, and
an answer built on them should say so. Review is what makes a semantic layer
trustworthy, and it is the only thing that does.
`;
}

/** The command reference: what to run, what comes back, and what it means. */
export function renderMoraGuide({
  connectionName,
  modelsDir,
  sampleTablePath,
}: AgentDocsOptions): string {
  return `# The mora command line

Mora maintains this file. Anything written here is replaced on upgrade, so put
project-specific notes in AGENTS.md under "Team conventions" instead.

Read this before running a \`mora\` command.

Every command accepts \`--json\` for a machine-readable report instead of prose,
and runs against the current directory unless told otherwise: \`init\` and
\`validate\` take the project directory as their argument, while \`describe\`,
\`query\`, \`schema\`, \`connection\` and \`plugin\` take it as \`-C <dir>\`, because
their own argument is a name. Note the case: \`-C\` is the directory, and on
\`mora schema\` a lower-case \`-c\` is the connection. Exit codes are the same
everywhere: \`0\` success, \`1\` failure, \`2\` bad usage, \`3\` refused because files
already exist.

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
  it by name. It takes a whole document, not just a query, so an expression can
  declare a source of its own and run against a table no model mentions yet:
  \`mora query -e "source: probe is ${connectionName}.table('${sampleTablePath}') extend {}\\nrun: probe -> { aggregate: rows is count() }"\`.
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

## mora schema [tables...]

Shows the *warehouse*, where \`describe\` shows the semantic layer. Reach for it
when a question is about data no model in \`${modelsDir}/\` describes yet.

\`\`\`bash
mora schema                              # every table the connection can read
mora schema --pattern order --json       # narrowed, for a large warehouse
mora schema orders customers --json      # columns and types, in one pass
mora schema --connection warehouse       # a connection other than the default
\`\`\`

Run the listing before anything else: it is where valid table names come from, so
no name has to be guessed, and each one goes inside \`<connection>.table('...')\`
unchanged. Naming several tables reads them all in one invocation. There is no
cached copy of any of this and there does not need to be — the listing is cheap,
and the answer stays in your context for as long as you are working.

\`--json\` reports \`{ ok, command: 'schema', connection, pattern, tables,
truncated, schemas, nextSteps }\`. Exactly one of \`tables\` and \`schemas\` is
filled in: \`tables\` when listing, each entry \`{ name, schema, kind }\` where
\`kind\` is \`table\`, \`view\` or \`file\`; \`schemas\` when tables were named, each
entry \`{ name, columns, error }\` with columns as \`{ name, type }\` in Malloy
types. A table that could not be read carries an \`error\` and makes \`ok\` false,
so an empty column list is never mistaken for a table without columns.
\`truncated\` is true when a very large catalog was cut short; narrow it with
\`--pattern\`.

What appears depends on the connection: a DuckDB connection lists data files as
well as registered tables, and a BigQuery connection lists the datasets the
credentials can see. An empty listing from a warehouse that clearly has data is a
permissions problem, not an empty warehouse — the error says which role to ask
for, and it is worth reporting rather than working around.

Seeing a table is not the same as understanding it. Read
\`.agents/modeling.md\` before proposing sources, and check the assumptions a
model would rest on against the data with \`mora query -e\`.

## mora connection list | test [name] | add [name]

A model reads from a named connection: \`${connectionName}.table('${sampleTablePath}')\`.
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
searchable list of the projects their credentials can query, narrowed to the ones
holding a dataset they can read — which is why an unattended run must pass the
project explicitly rather than expect a default.

## mora plugin list | add <name> | remove <name>

A plugin is an optional integration the project opts into. \`mora plugin list\`
shows what Mora offers and what this project uses; each entry reports \`added\`
(recorded in \`mora.yaml\`) separately from \`installed\` (usable in this checkout),
because a third-party plugin's package lives in the gitignored \`.mora/plugins/\`
and so is missing from a fresh clone.

\`\`\`bash
mora plugin list --json
mora plugin add publisher            # serve these models with Malloy Publisher
mora plugin remove publisher
\`\`\`

Adding writes files the project then owns, records the plugin in \`mora.yaml\`, and
puts a note in the managed block of AGENTS.md. Commit the result. Re-running add
is safe: a file that already matches is left alone, and a file the team has since
edited is kept rather than overwritten.

Removing deletes only the files the plugin would write today. If any of them has
local edits the command refuses with exit \`3\` and writes nothing at all, so a
failed remove never leaves the project half changed — pass \`--force\` to delete
them anyway, or \`--keep-files\` to keep the files and only stop tracking the
plugin. The report lists every file as \`deleted\`, \`kept-modified\`,
\`kept-by-flag\` or \`missing\`.

Do not add a plugin because a question was hard to answer; ask the person you are
working with first. A plugin changes what the repository contains.

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
layer: \`mora.yaml\` with one connection, an empty \`${modelsDir}/\`, and the docs
you are reading. Pass \`--db\` and any required setting as a flag so it does not
need to prompt; for BigQuery that is usually
\`--project-id '\${GOOGLE_CLOUD_PROJECT}'\`. Name the connection with
\`--connection\`; it defaults to the database.

Then it opens that connection, and **a scaffold whose connection does not answer
is deleted again**. The report says \`rolledBack: true\` and \`files\` is empty, so
nothing was left half-built to clean up: fix the setting or the credential and
run init again. \`--no-test\` skips the check and keeps the scaffold, which is the
flag to use when the credential will only exist later.

In a project that already has \`mora.yaml\`, this is a setup run: it creates a
local \`.env\` from \`.env.example\`, reports which credentials are unset, notes
when \`mora upgrade\` (or a newer CLI) is needed, and compiles the models. It does
not touch models, configuration, or Mora-owned docs — those are \`mora upgrade\`'s
job. Run it after cloning.
`;
}

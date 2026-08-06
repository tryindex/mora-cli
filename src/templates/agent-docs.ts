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

Mora maintains this file. Anything written here is replaced when Mora rewrites
it, so project-specific notes belong in \`${modelsDir}/conventions.md\` if they
are about how this team defines metrics, and in AGENTS.md under "Team
conventions" otherwise.

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
  before writing a source against a table you have not read from yet, and
  \`mora schema\` for the table names that connection accepts.

## Doc strings

A line beginning with \`#"\` above a definition is its description. Unlike a
\`//\` comment it is part of the model, so it travels with the definition to
anything that reads the model rather than the file. It is how a definition
explains itself to a reader who was not in the room when it was agreed, so it is
the difference between a name someone trusts and a name someone re-derives by
hand.

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

1. Read the files in \`${modelsDir}/\` to see what already exists. Reuse before
   adding: a second measure that means what the first one means is how two
   answers start disagreeing.
2. Check anything you are about to assume about the data with
   \`mora query -f\`, rather than trusting a column name.
3. Agree what the new definition means with the person who asked for it, using
   the questions in \`.agents/modeling.md\`. They apply to a measure added to an
   existing source exactly as they do to a new one: what a number means is not
   yours to decide, and the answers are what the doc string has to say.
4. Add the dimension, measure or view next to related definitions, with a \`#"\`
   doc string on every new definition.
5. Run \`mora validate\`. Because Malloy resolves table schemas while compiling,
   a pass means the model parses *and* the referenced columns really exist.
6. Run the query with \`mora query\` and report the answer together with the
   definitions it used, so a human can check the logic and not just the number.
7. Commit and open a pull request. Until it is reviewed, say that the definition
   is proposed.

## Changing something that already exists

Definitions are shared. Editing a measure changes every answer that uses it,
including ones already in dashboards and documents. Prefer adding a new
definition next to the old one. If a change really is a correction, say so
plainly in your answer, and name what else depends on it.
`;
}

/**
 * How to turn a warehouse nobody has modelled yet into a first semantic layer.
 * This is the guide the tool exists for: the commands are here to serve it, and
 * `.agents/malloy.md` answers "how do I write this" once this one has settled
 * what is worth writing at all.
 */
export function renderModelingGuide({
  connectionName,
  modelsDir,
  sampleTablePath,
}: AgentDocsOptions): string {
  return `# Proposing a semantic layer

Mora maintains this file. Anything written here is replaced when Mora rewrites
it, so project-specific notes belong in \`${modelsDir}/conventions.md\` if they
are about how this team defines metrics, and in AGENTS.md under "Team
conventions" otherwise.

Read this when the warehouse has tables that \`${modelsDir}/\` does not cover yet.
For adding a measure to a source that already exists, \`.agents/malloy.md\` is the
guide you want; this one is about proposing sources that do not exist. The
questions in section 3 apply either way — every new metric goes through them.

The shape of the work, and none of the steps are optional:

\`\`\`
1. mora schema        what the warehouse holds
2. mora sync          copy those tables locally, so checking them is free
3. mora query -f      what is true of it, checked rather than assumed
4. ask a human        which of it is worth modelling
5. write the models   documented definitions, in ${modelsDir}/
6. mora validate      they compile, so the columns really exist
7. pull request       a human approves them, which is what makes them trustworthy
\`\`\`

## When this applies

The models in \`${modelsDir}/\` do not describe the data you were asked about.
Check the connection works first (\`mora connection test\`): everything below
reads the database, and a credential problem reported as a modelling problem
wastes the reader's time.

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

Once you know which tables matter, copy them locally. Everything in this step is
a question nobody will act on, and there are going to be a lot of them:

\`\`\`bash
mora sync --table ${sampleTablePath}     # or plain \`mora sync\` once a model reads it
\`\`\`

After that a probe reads the local copy automatically and costs nothing. It is a
copy, so treat any number from it as provisional — the result says \`local: true\`
and carries \`syncedAt\`, and re-running with \`--remote\` gives the warehouse's
answer. **Before a number goes into a doc string or a pull request, check it with
\`--remote\`.** Skipping the sync is fine; every command below works either way.

Then query the data. Nothing is modelled yet, so declare a throwaway source in
the probe itself and run against that. Unreviewed Malloy is a whole document, so
the source and the query travel together and no model is touched. Write it to a
file — a probe runs to several lines, and a file is easier to edit than a shell
argument:

\`\`\`bash
cat > /tmp/probe.malloy <<'MALLOY'
source: probe is ${connectionName}.table('${sampleTablePath}') extend {}
run: probe -> { aggregate: rows is count() }
MALLOY
mora query -f /tmp/probe.malloy
\`\`\`

**Never infer meaning from a column name. Query the data.** A column called
\`total\` may or may not include tax. A \`status\` column may have five values or
five hundred. A foreign key may point at rows that are not there. Names suggest;
only the data decides. Establish each of these before you propose anything:

| What to establish | Why it changes the model |
| --- | --- |
| Duplicate keys: \`group_by\` the key, \`aggregate: count()\`, then filter to more than one | Duplicates make every \`sum()\` wrong, and silently. |
| Join cardinality: is the foreign key unique on the other side? | Decides \`join_one\` against \`join_many\`. Guessing double-counts. |
| Null rates per column | A column that is mostly null is not a dimension worth offering. |
| Distinct values of each categorical | Five statuses group well; five hundred do not. |
| Distributions (min, max, percentiles) of key numbers | Tier boundaries come from the data, not from round numbers. |
| Related money columns, compared | Whether \`total\` is \`subtotal + tax\` decides which one revenue means. |
| Candidate date columns, compared | Which timestamp is the canonical one to report on. |

Ask one question per document. Malloy runs only the last query in a document, so a
file with several \`run:\` statements is refused rather than answered in part —
either rewrite the file for each question, or fold the checks into a single
\`run:\` with several aggregates, which is often the better probe anyway:

\`\`\`malloy
source: probe is ${connectionName}.table('${sampleTablePath}') extend {}

// Several checks, one answer: row count against distinct keys catches
// duplicates, and the null counts say which columns are worth offering.
run: probe -> {
  aggregate:
    rows is count()
    distinct_ids is count(id)
    null_region is count() { where: region = null }
}
\`\`\`

The two that matter most read like this, keeping the same \`probe\` declaration
at the top of the file:

\`\`\`malloy
source: probe is ${connectionName}.table('${sampleTablePath}') extend {}

// Is the key unique? Anything but zero means sum() cannot be trusted.
run: probe
  -> { group_by: id; aggregate: rows is count() }
  -> { where: rows > 1; aggregate: duplicate_keys is count() }
\`\`\`

\`\`\`malloy
source: probe is ${connectionName}.table('${sampleTablePath}') extend {}

// How many rows, and how many distinct values of the key you would join on.
run: probe -> { aggregate: rows is count(), customers is count(customer_id) }
\`\`\`

A short probe can still go on the command line
(\`mora query -e "source: ... run: ..."\`), and stdin works too
(\`mora query -e - < probe.malloy\`). Every one of these is marked
\`reviewed: false\`, which is correct: they are throwaway checks, not
definitions. Nothing here belongs in the model as written.

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

## 3. Agree what each metric means

A scope says which domain to model. It does not say what \`revenue\` means, and
that is the part you cannot decide. A measure will be read by people who were
not in the room and who will trust it without re-deriving it, so the definition
has to be the one the business already uses, not a reasonable one you inferred.

Work through the questions below before writing any metric, whether it is the
first in a new source or a measure added to one that exists.

**Read before you ask.** Go through \`${modelsDir}/*.malloy\` and
\`${modelsDir}/conventions.md\` first. The models say what is already defined and
what those definitions leave out; \`conventions.md\` is where this team records
the answers that hold for every metric — canonical sources, calendar, standard
exclusions, who approves a change. Anything answered there is settled. Bring
what you found as statements to be corrected, ask only about what is genuinely
open, and put all of it in one message rather than a question at a time.

1. **Relationship to what exists.** Does something in \`${modelsDir}/\` already
   mean this, or nearly? Is this new, a variant of an existing metric, or one of
   its drivers? Which direction is good when it moves? A second measure that
   means what the first one means is how two answers start disagreeing, and a
   variant belongs next to what it varies from, named for the difference.
2. **Name, definition, unit.** The exact name, a one-sentence definition in
   plain language, and the unit — a count, an amount of money, a percentage. If
   it is a ratio: what is the numerator, what is the denominator, and what the
   metric should be when the denominator is zero.
3. **Source of truth.** Which table, on which connection, is authoritative for
   this — and what official number does it have to reconcile against? A metric
   that disagrees with the figure the team already reports is wrong until
   someone says otherwise, whichever one the query supports.
4. **Grain and time.** Which timestamp is the canonical one to report on, given
   that a row usually has several. At what granularity is the metric read, and
   under which calendar: when does a week start, does the fiscal year differ
   from the calendar year, and which timezone is a day measured in?
5. **Dimensions and filters.** Which attributes does it need to be sliced by,
   and over which join keys — only ones whose cardinality you verified. Which
   rows are excluded from the population, and what does excluding them leave
   out: test accounts, internal orders, cancelled rows, a region that is null on
   3% of rows.
6. **Evidence.** Which probes settle the assumptions this definition rests on —
   key uniqueness, null rates, the reconciliation in question 3. Run them with
   \`mora query -f\` and keep the results: they are what the pull request
   description is made of.
7. **Ownership.** Who owns this definition and approves the pull request. If
   \`conventions.md\` names someone, that is the answer.

What to do with the answers, and this is the part that makes the next metric
cheaper:

- **Answers about this metric become its \`#"\` doc string.** The definition, the
  unit, what the population excludes, what surprised you. A caveat that lives
  only in the message you sent is a caveat the next reader will not have.
- **Answers that hold for every metric go in \`${modelsDir}/conventions.md\`,** in
  the same pull request. That file is the team's, Mora never rewrites it, and
  every answer added to it is a question nobody has to be asked again.
- **An unanswered question is not yours to answer.** Say which one is open and
  what it blocks. If you are told to proceed anyway, write the assumption into
  the doc string in so many words, so the reviewer is deciding about it rather
  than inheriting it.

## 4. Write the models

Once a human has picked a scope and answered the questions above, write it into
\`${modelsDir}/\`. Read \`.agents/malloy.md\` first for the syntax and the doc
string conventions; the rules specific to a first draft are these:

- One file per base source, named for the table it wraps.
- \`primary_key\` on anything that has one, from the key you verified is unique.
- Joins only where you checked the cardinality, using the relationship the data
  showed rather than the one the column names imply.
- A few measures that answer the questions from the scope you agreed. Resist
  adding every aggregate that is possible.
- A \`#"\` doc string on every definition, carrying the answers from section 3:
  what it means, what it leaves out, and which figure it reconciles with. A
  measure whose caveats are undocumented invites someone to re-derive it, which
  is the problem the semantic layer exists to solve.
- Where the data surprised you, say so in the doc string. "Excludes the 3% of
  rows with a null region" is exactly the kind of thing that must not live only
  in your answer.
- Anything you learned that holds for every metric, not just this one, goes in
  \`${modelsDir}/conventions.md\`.

## 5. Validate, then hand it over

\`\`\`bash
mora validate                     # compiling proves the columns really exist
mora query orders.revenue_by_month
\`\`\`

Both of these read the warehouse, and that is the point of running them here. If
you used \`mora sync\` while exploring, every number you gathered came from a copy;
re-check the ones you are about to write down. A caveat in a doc string that was
true of a stale extract and is not true of the warehouse is worse than no caveat,
because it reads as though somebody verified it.

Spot-check each measure against something known before reporting anything. Then
commit and open a pull request. Say in it what you checked and what you found,
including the surprises, and reconcile each metric against the official number
named in section 3: the reviewer is deciding whether to trust these definitions,
and those checks are most of the evidence.

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

Mora maintains this file. Anything written here is replaced when Mora rewrites
it, so project-specific notes belong in \`${modelsDir}/conventions.md\` if they
are about how this team defines metrics, and in AGENTS.md under "Team
conventions" otherwise.

Read this before running a \`mora\` command.

There are six commands, and four of them are one loop: \`schema\` to see what
the warehouse holds, \`query\` with unreviewed Malloy to check what is true of it,
\`validate\` to prove a model you wrote compiles, \`query\` by name to run a
definition someone reviewed. \`sync\` makes the checking step cheap by copying
those tables locally, and \`init\` and \`connection\` set the project up so the
loop can run.

Every command accepts \`--json\` for a machine-readable report instead of prose,
and runs against the current directory unless told otherwise: \`init\` and
\`validate\` take the project directory as their argument, while \`query\`,
\`schema\` and \`connection\` take it as \`-C <dir>\`, because their own argument is
a name. Note the case: \`-C\` is the directory, and on \`mora schema\` a lower-case
\`-c\` is the connection. Exit codes are the same everywhere: \`0\` success,
\`1\` failure, \`2\` bad usage, \`3\` refused because files already exist.

## Finding what the semantic layer already defines

There is no command for this: read the \`.malloy\` files in \`${modelsDir}/\`.
They are the vocabulary, they are in the checkout, and reading them gives you the
definitions with their doc strings, their filters and their joins — more than any
listing would. Do it before writing a query, so an answer reuses a definition
someone reviewed instead of inventing one, and report the doc string of anything
you use so the reader gets its caveats too.

\`${modelsDir}/conventions.md\` sits alongside them and holds what is true of
every metric here: canonical sources, the calendar, standard exclusions, who
approves a change. Read it before adding a definition — it is the team's own
file, and the questions it answers are ones you would otherwise have to ask.

## mora query <name> | -f <file> | -e "<malloy>"

Runs a query and prints the rows with the SQL that produced them.

\`\`\`bash
mora query monthly_revenue              # a query: declaration
mora query orders.revenue_by_month      # a view, as source.view
mora query revenue_by_month             # unambiguous view names resolve alone
mora query -f probe.malloy              # Malloy the model does not define
\`\`\`

A name runs reviewed logic. \`-f\` and \`-e\` run Malloy nobody has reviewed, and
the result is marked \`reviewed: false\`: use them to check what is true of the
data, then promote anything worth keeping to a named view or query and run it by
name.

Flags:

- \`-f, --file <path>\` runs a Malloy document from a file. Prefer this for
  anything more than one line — a probe that declares its own source is several
  lines long, and a file is easier to write and to edit than a quoted shell
  argument.
- \`-e, --expr <malloy>\` runs Malloy given inline; \`-e -\` reads the document from
  stdin. Like \`-f\`, it takes a whole document rather than just a query, so it
  can declare a source of its own and read a table no model mentions yet:
  \`mora query -e "source: probe is ${connectionName}.table('${sampleTablePath}') extend {}\\nrun: probe -> { aggregate: rows is count() }"\`.
- \`--sql\` prints the generated SQL and runs nothing. Useful for checking what a
  definition compiles to before executing it.
- \`--limit <n>\` caps the rows returned. Keep it small: rows land in your
  context.
- \`--local\` reads the local cache and fails rather than falling back;
  \`--remote\` forces the warehouse. See "Local vs warehouse" below.

**One \`run:\` per document.** Malloy runs only the last query in a document, so a
file with several \`run:\` statements is refused (exit \`2\`, code
\`multiple-queries\`) rather than answering one question and looking like it
answered all of them. Ask one question per document, or combine the checks into a
single \`run:\` with several aggregates.

\`--json\` reports \`{ ok, command: 'query', name, reviewed, model, sql, executed,
local, syncedAt, fellBackToWarehouse, cappedTables, rows, rowCount, truncated,
nextSteps }\`. \`executed\` is false under \`--sql\`, so an empty \`rows\` is never
mistaken for a query that matched nothing. An unknown name exits \`1\` with code
\`unknown-definition\` and lists what does exist.

Always include the SQL, or the definitions used, alongside a number you report.
An answer nobody can audit is not worth much.

### Local vs warehouse

If \`mora sync\` has been run, a probe (\`-f\` or \`-e\`) reads the local cache when
it holds the tables, and the warehouse when it does not. A name always reads the
warehouse unless you pass \`--local\`.

The split is deliberate. A probe is a question about the data that nobody will
act on, and there are dozens of them; a named definition is an answer somebody
acts on, and one that is three days old is worse than one that took four
seconds.

Read \`local\` on every result before you report a number:

- \`local: true\` — these rows are a copy, as old as \`syncedAt\`. Say so, and
  re-run with \`--remote\` before the number goes anywhere that matters.
- \`cappedTables\` non-empty — the cache stopped at a row limit for those tables.
  A count or a fraction over one of them is **not** the warehouse's answer.
  Check it with \`--remote\`.
- \`fellBackToWarehouse: true\` — the cache could not answer, so these rows are
  current. Run \`mora sync\` if you will be probing that table again.

## mora sync

Copies the tables the models read into local Parquet under \`.mora/cache/\`, so
probing them costs nothing and hits no warehouse bill. It is gitignored, and
nothing runs it for you: the cache is exactly as old as the last time you did.

\`\`\`bash
mora sync                                # every table the models read
mora sync --status                       # what is cached and how old, syncs nothing
mora sync --table analytics.orders       # also cache a table no model reads yet
mora sync --limit 5000                   # smaller extracts
\`\`\`

Run it when you are about to check a lot of assumptions about the same tables —
step 1 of \`.agents/modeling.md\` is the case it was built for. Re-run it whenever
the answers start to matter, because nothing refreshes on its own.

\`--json\` reports \`{ ok, command: 'sync', cacheDir, executed, models,
modelFailures, synced, cached, syncedAt, age, rows, limit, nextSteps }\`. A table
that could not be read is an entry in \`synced\` with \`status: 'failed'\`, not a
dead command: the tables that did come through are still worth having.

## mora validate

Compiles every model in \`${modelsDir}/\`. Run it after any edit to a \`.malloy\`
file, and before opening a pull request. Malloy resolves table schemas while
compiling, so a pass means the model parses *and* the columns it names really
exist. \`--json\` lists each model with its sources, named queries and any compile
error.

\`--local\` compiles against the cache instead, which is fast enough to run on
every edit. It is a weaker promise — it proves the columns exist in the copy, so
a column added upstream since the sync is not there and one dropped upstream
still is. Run it without \`--local\` before opening a pull request.

## mora schema [tables...]

Shows the *warehouse*, where the models in \`${modelsDir}/\` are the semantic
layer over it. Reach for it when a question is about data no model describes yet.

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
truncated, schemas, readsFrom, dataElsewhere, nextSteps }\`. Exactly one of \`tables\` and \`schemas\` is
filled in: \`tables\` when listing, each entry \`{ name, schema, kind }\` where
\`kind\` is \`table\`, \`view\` or \`file\`; \`schemas\` when tables were named, each
entry \`{ name, columns, error }\` with columns as \`{ name, type }\` in Malloy
types. A table that could not be read carries an \`error\` and makes \`ok\` false,
so an empty column list is never mistaken for a table without columns.
\`truncated\` is true when a very large catalog was cut short; narrow it with
\`--pattern\`.

What appears depends on the connection: a DuckDB connection lists data files as
well as registered tables, a Postgres connection lists every table its role can
see qualified with its schema, and a BigQuery connection lists the datasets the
credentials can see. An empty listing from a warehouse that clearly has data is a
permissions problem, not an empty warehouse — the error says which role to ask
for, and it is worth reporting rather than working around.

An empty listing from a DuckDB connection usually means it is pointed at the
wrong directory. \`readsFrom\` says which directory it resolves relative table
paths from, and \`dataElsewhere\` names the directories in the project that do hold
data files, so the fix is to set \`working_directory\` on the connection in
\`mora.yaml\` to one of them. Do not read this as an empty database.

A Postgres table path is always \`schema.table\`, as the listing prints it. Malloy's
Postgres dialect has no default schema, so a bare table name fails even where
\`search_path\` would have found it.

Seeing a table is not the same as understanding it. A schema cannot say whether a
key has duplicates, whether a foreign key is unique on the other side, or whether
\`total\` includes tax, and each of those changes the model. Read
\`.agents/modeling.md\` before proposing sources, and check every one of those
assumptions against the data with \`mora query -f\`.

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
mora connection add shop --type postgres --host db.internal --database shop --json
mora connection add exports --type duckdb --database exports.duckdb --yes
\`\`\`

Write a credential as \`\${VAR}\`, never as a literal: \`mora.yaml\` is committed.
The command records the variable in \`.env.example\` and reports it under
\`missingEnvVars\` if it is unset; the value itself belongs in \`.env\`, which only
the person running it can write.

BigQuery uses Application Default Credentials when \`service_account_key_path\` is
unset, so a \`test\` that fails on a keyless connection usually means
\`gcloud auth application-default login\` has not been run for an account with
access. Ask the person you are working with to run it; it needs a browser, so you
cannot do it for them.

Postgres takes \`--host\`, \`--port\`, \`--database\` and \`--user\`, and its password is
written as \`\${POSTGRES_PASSWORD}\` by default. A managed Postgres refuses an
unencrypted connection, so add \`--ssl true\` for Neon, Supabase or RDS.

## mora init

Two modes. In a directory without \`mora.yaml\`, init scaffolds a new semantic
layer: \`mora.yaml\` with one connection, an empty \`${modelsDir}/\`, and the docs
you are reading. Pass \`--db\` and any required setting as a flag so it does not
need to prompt: for BigQuery that is usually
\`--project-id '\${GOOGLE_CLOUD_PROJECT}'\`, and for Postgres \`--host\` and
\`--database\`. Name the connection with \`--connection\`; it defaults to the
database.

Then it opens that connection, and **a scaffold whose connection does not answer
is deleted again**. The report says \`rolledBack: true\` and \`files\` is empty, so
nothing was left half-built to clean up: fix the setting or the credential and
run init again. \`--no-test\` skips the check and keeps the scaffold, which is the
flag to use when the credential will only exist later.

In a project that already has \`mora.yaml\`, this is a setup run: it creates a
local \`.env\` from \`.env.example\`, reports which credentials are unset, and
compiles the committed models so the checkout is known to work. It touches
nothing the team owns — not the models, not the configuration, not these docs.
Run it after cloning.
`;
}

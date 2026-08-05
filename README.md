# Mora

**Turn a warehouse into a semantic layer your team reviewed and your agent can query.**

Coding agents write SQL well and cannot be trusted with it. Every question gets a
fresh query, every query re-derives what "revenue" or "active customer" means,
and nobody notices when two answers quietly disagree.

Mora is a command line for the work that fixes that: going from a warehouse
nobody has modelled to definitions a human approved, written in
[Malloy](https://malloydata.dev). Its whole shape is one loop.

```
1. mora schema        what the warehouse holds
2. mora query -f      what is true of it, checked rather than assumed
3. ask a human        which of it is worth modelling
4. write the models   documented definitions, in metrics/
5. mora validate      they compile, so the columns really exist
6. pull request       a human approves them, which is what makes them trustworthy
```

The middle two steps are the point. An agent that reads a schema and writes
`revenue is total.sum()` has guessed whether `total` includes tax; one that ran
the query first has not. And a definition nobody reviewed is worth no more than
the SQL it replaced, which is why the loop ends in a pull request rather than in
an answer.

Mora is a CLI, so any agent that can run a command can use it: Cursor, Claude
Code, Codex, or your own.

> **Status: early.** Five commands, DuckDB, Postgres and BigQuery. See
> [Roadmap](#roadmap).

## Install

Needs Node 20.11 or newer, and nothing else.

```bash
npm install -g @moradata/cli    # then run `mora`
npx @moradata/cli init          # or run it without installing anything
```

Install it globally if an agent is going to use it: `mora` on `PATH` is one less
thing for it to work out, and one less network round trip per command. Nothing in
a project pins a Mora version, so updating is `npm i -g @moradata/cli@latest`.

## Quick start

```bash
npx @moradata/cli init
```

That asks for a project name and a data source, then writes:

```
mora.yaml               # models directory + database connections
metrics/                # your Malloy models. Empty: they are yours to write
  conventions.md        # what a metric means here. Yours, and never rewritten
AGENTS.md               # the loop your agent follows, plus your own conventions
.agents/
  modeling.md           # warehouse to reviewed definitions, step by step
  malloy.md             # how to write Malloy
  mora.md               # the commands, their flags and their output
.env.example            # which credentials the project needs, if any
```

Those files are meant to be committed. Before finishing, `init` opens the
connection you configured; a scaffold whose connection does not answer is removed
again rather than left half-built.

When a teammate clones the repo and runs the same command, Mora sets up their
checkout instead of scaffolding again — see
[Adopting a project someone else set up](#adopting-a-project-someone-else-set-up).

## Hand it to your agent

Nothing else to configure: open the project in Cursor, Claude Code or Codex and
paste this.

```
Read AGENTS.md, then .agents/modeling.md. Run `mora schema` to see what we have.
Before you write any model, tell me what you propose to define and which
assumptions you checked with `mora query -f`.
```

It will find `metrics/` empty, list the tables, probe the ones it means to model,
and come back with a scope rather than a model. Approving that scope is the only
step it cannot do for you, and it is the step that makes the definitions worth
having.

## Five minutes, no warehouse needed

DuckDB reads local files and needs no credentials, so the whole loop runs on a CSV
in a temp directory. Every output below is real.

**Scaffold it, and give it something to read.** A DuckDB connection resolves
relative table paths from the models directory, the same way
[Malloy Publisher](https://github.com/malloydata/publisher) resolves a package's,
so `metrics/data/orders.csv` is `data/orders.csv` to a model:

```bash
mkdir mora-demo && cd mora-demo
npx @moradata/cli init --db duckdb --yes

mkdir -p metrics/data
cat > metrics/data/orders.csv <<'CSV'
id,customer_id,ordered_at,amount,status
1,7,2024-01-05,120.00,complete
2,7,2024-01-19,80.50,complete
3,9,2024-02-02,540.00,complete
4,9,2024-02-11,35.25,refunded
5,12,2024-03-08,210.75,complete
CSV
```

**1. See what is there.** No table name gets guessed; the listing is where they
come from.

```
$ mora schema
◇  Tables in duckdb duckdb ─╮
│    data/orders.csv  file  │
├───────────────────────────╯
└  1 table

$ mora schema data/orders.csv
◇  data/orders.csv  duckdb duckdb ─╮
│    id           number           │
│    customer_id  number           │
│    ordered_at   date             │
│    amount       number           │
│    status       string           │
├──────────────────────────────────╯
└  1 table, 5 columns.
```

**2. Check what is true of it.** There is a `status` column, so "revenue" has a
decision in it. Ask the data, in `probe.malloy`:

```malloy
source: probe is duckdb.table('data/orders.csv')

run: probe -> {
  aggregate:
    rows is count()
    distinct_ids is count(id)
    refunded is count() { where: status = 'refunded' }
    null_amounts is count() { where: amount = null }
}
```

```
$ mora query -f probe.malloy
▲  Unreviewed: this ran Malloy that is not in the model, so the logic behind these
│  numbers has not been reviewed by anyone.
◇  Rows ───────────────────────────────────────╮
│  rows  distinct_ids  refunded  null_amounts  │
│  5     5             1         0             │
├──────────────────────────────────────────────╯
└  1 row (unreviewed).
```

`id` is unique, so summing is safe, and one row in five is refunded — which is
the number that makes the next step a decision rather than a guess.

**3. Decide, then write it down.** Whether a refund counts is yours to settle, not
your agent's. Say it excludes them, and `metrics/orders.malloy` records both the
rule and the reason:

```malloy
#" One row per order placed, from the export in data/orders.csv.
source: orders is duckdb.table('data/orders.csv') extend {
  primary_key: id

  measure:
    #" Number of orders, refunded ones included.
    order_count is count()
    #" Order amount summed. Excludes refunds: status = 'refunded' is 1 of 5 rows.
    revenue is amount.sum() { where: status != 'refunded' }

  #" Revenue and order count by month the order was placed.
  view: revenue_by_month is {
    group_by: ordered_at.month
    aggregate: revenue, order_count
  }
}
```

**4. Prove it compiles, then use it.** Malloy resolves table schemas at compile
time, so a pass means the columns really exist:

```
$ mora validate
◇  Models ──────────────────────────────────────────────────╮
│    pass metrics/orders.malloy  1 source, 0 named queries  │
├───────────────────────────────────────────────────────────╯
└  1 model compiled against duckdb.

$ mora query orders.revenue_by_month
◇  Rows ─────────────────────────────╮
│  ordered_at  revenue  order_count  │
│  2024-03-01  210.75   1            │
│  2024-02-01  540      2            │
│  2024-01-01  200.5    2            │
├────────────────────────────────────╯
└  3 rows.
```

No warning this time: the logic came from a committed model rather than from the
prompt. In a real project the last step is a pull request, and `revenue` means one
thing from then on.

Point `init` at [Postgres or BigQuery](#mora-connection) and nothing about the
loop changes.

## Designed for agents

Interactive prompts are the fallback, not the interface. Every prompt has a flag
so an agent can run Mora unattended:

```bash
mora init ./analytics --db duckdb --name analytics --yes --json
```

- `--yes` never prompts; `--json` implies it and prints a structured result.
- Exit codes are meaningful: `0` success, `1` failure, `2` bad usage, `3` refused
  because files already exist.
- Every report is JSON with the same shape as the prose, so nothing an agent
  reads is derived separately from what a human reads.

There is deliberately no command that lists the vocabulary. The models are in the
checkout: an agent reads `metrics/*.malloy` and gets the definitions with their
doc strings, filters and joins, which is more than a summary would give it.

## `mora schema`

```
Usage: mora schema [options] [tables...]

Options:
  -c, --connection <name>  connection to read (default: the project default)
  -C, --directory <dir>    project directory (default: .)
  --pattern <text>         only list tables whose name contains this text
  --json                   print a machine-readable result instead of prose
```

The first step of the loop, and the answer to the question an agent hits the
moment it is asked about data nobody has modelled: what is even in here?

Run it with no argument first. The listing is where valid table names come from,
so nothing has to be guessed, and every name it prints goes inside
`<connection>.table('...')` unchanged:

```
$ mora schema
┌   mora schema
│
◇  Tables in warehouse bigquery ──────────╮
│    analytics.orders     table           │
│    analytics.customers  table           │
├─────────────────────────────────────────╯
│
└  2 tables
```

Then read the columns, naming as many tables as you want in one pass:

```bash
mora schema analytics.orders analytics.customers --json
```

The types that come back are Malloy types, because they are read the same way a
model reads them — a table that describes cleanly here is one a source can be
written against. A table that cannot be read carries its own `error` and makes
`ok` false, so an empty column list is never mistaken for a table with no
columns.

There is no cached catalog on disk, and deliberately so. The listing is cheap, an
agent keeps the answer in context for as long as it is working, and the only
thing a stored copy would add is the ability to outlive the warehouse it
describes. For a very large catalog, narrow it with `--pattern`; `truncated` says
when a listing was cut short.

What gets listed depends on the connection. A DuckDB connection reads files as
well as registered tables, so both appear, with the files named relative to the
connection's working directory. A Postgres connection lists every table its role
can see, qualified with its schema. A BigQuery connection lists the whole project
where it is allowed to, and otherwise falls back to the datasets your credentials
can actually see — being told nothing because most of the project is none of your
business is not an answer. If even that is denied, the error names the role to ask
for.

An empty listing says why it is empty. A DuckDB connection opens whether or not
the directory it reads holds anything, so "no tables" usually means the
`working_directory` is not where the data is: the report names the directory it
read, names the directories in the project that do hold data files, and gives the
one-line change to `mora.yaml` that fixes it.

**Seeing a table is not the same as understanding it.** A schema cannot tell you
whether a key has duplicates, whether a foreign key is unique on the other side,
or whether `total` includes tax — and each of those changes the model. That is
what the next step is for.

## `mora query`

```
Usage: mora query [options] [name]

Options:
  -e, --expr <malloy>    run Malloy the model does not define ("-" reads stdin)
  -f, --file <path>      run Malloy from a file
  -C, --directory <dir>  project directory (default: .)
  --sql                  print the generated SQL without running it
  -l, --limit <n>        largest number of rows to return (default: 50)
  --json                 print a machine-readable result instead of prose
```

`query` wears two hats, and the report says which one it is wearing.

**Checking the data, before any model exists.** `-f` runs a Malloy document from
a file, and a document can declare its own source — which is what makes it
possible to interrogate a table nothing has modelled yet:

```malloy
source: probe is warehouse.table('analytics.orders') extend {}

// Is the key unique? Anything but zero means sum() cannot be trusted.
run: probe
  -> { group_by: id; aggregate: rows is count() }
  -> { where: rows > 1; aggregate: duplicate_keys is count() }
```

```bash
mora query -f probe.malloy
```

A probe is several lines, so a file beats a quoted shell argument; `-e` still
takes it inline and `-e -` reads stdin. These results are marked
`reviewed: false` and carry a visible warning, which is correct — a throwaway
check is not a definition.

One document asks one question. Malloy runs only the last query in a document, so
a file with several `run:` statements is refused rather than answering one of
them and looking like it answered all of them. Combine the checks into a single
`run:` with several aggregates, or write a document per question.

**Answering with logic someone approved.** A name runs a committed definition,
either a `query:` declaration or a view written as `source.view`:

```bash
mora query monthly_revenue
mora query orders.revenue_by_month --limit 12
```

Every result comes with the SQL that produced it, so a human can audit how an
answer was reached rather than taking the number on faith. `--sql` prints that
SQL without executing anything.

Unreviewed Malloy is allowed on purpose — forbidding it would push an agent back
to raw SQL, and it is how the data gets checked in the first place — but the
output nudges toward promoting anything worth keeping into a named definition,
where a pull request can catch a mistake before a dashboard does.

`--json` reports `{ ok, command, name, reviewed, model, sql, executed, rows,
rowCount, truncated, nextSteps }`. `executed` is separate from `rows` so a query
that never ran cannot be mistaken for one that matched nothing. An unknown name
exits `1` and lists the names that do exist.

## `mora validate`

```
Usage: mora validate [options] [directory]

Options:
  --json               print a machine-readable result instead of prose
```

`validate` reads `mora.yaml`, finds every `.malloy` file under the models
directory, and compiles each one. Run it after editing a model, and in CI: it is
the check that keeps a semantic layer honest, because Malloy resolves table
schemas at compile time, so a pass means the model parses *and* the referenced
columns really exist.

```
$ mora validate
┌   mora validate
│
◇  Models ────────────────────────────────────────────────────╮
│    pass metrics/orders.malloy  1 source, 3 named queries    │
├─────────────────────────────────────────────────────────────╯
│
└  1 model compiled against warehouse.
```

Exit code `0` means every model compiled, `1` means at least one failed or the
project could not be read. `--json` reports each model with its sources, named
queries, compile duration and error text. A model reading from a connection type
Mora has no driver for says so, rather than passing quietly.

## What a model looks like

This is the artifact the whole loop exists to produce:

```malloy
#" One row per order, with the customer who placed it.
source: orders is warehouse.table('analytics.orders') extend {
  primary_key: id

  dimension:
    #" Date the order was placed.
    ordered_at is order_date::date
    #" An order over $500. The threshold is a business convention.
    is_large_order is amount > 500

  measure:
    #" Number of orders.
    order_count is count()
    #" Total order amount, including orders not yet completed.
    revenue is amount.sum()

  #" Revenue and order count for each month.
  view: revenue_by_month is {
    group_by: ordered_at.month
    aggregate: revenue, order_count
  }
}

query: monthly_revenue is orders -> revenue_by_month
```

`revenue` is now defined in exactly one place. Every query that uses it, whether
written by you or by an agent, means the same thing.

The `#"` lines are doc strings, and they are part of the model rather than
comments on it, so a definition arrives with the caveats that make it safe to
use. "Excludes the 3% of rows with a null region" belongs there, not in the
answer an agent gave once.

## Every metric gets agreed, not inferred

An agent can find out from the data whether `total` includes tax. It cannot find
out whether your company counts a refunded order in revenue, when your week
starts, or which of three plausible timestamps the finance team reports on. Those
are decisions, and a definition that quietly makes them on your behalf is the
thing this tool exists to prevent — it will be read by people who were not in the
room and trusted without being re-derived.

So `.agents/modeling.md` gives the agent a fixed set of questions to work through
before it writes any metric, whether that is a new source or one more measure on
an existing one: how this relates to what is already defined, the name and unit
and the formula if it is a ratio, which table is authoritative and which official
number it must reconcile against, the canonical timestamp and the calendar, the
dimensions and the population it excludes, the probes that back all of it, and
who approves the pull request. The answers do not stay in the chat: per-metric
ones become the `#"` doc string, so they travel with the definition.

Answers that hold for every metric go in `metrics/conventions.md`, which `init`
scaffolds as a set of unanswered prompts:

```
## Canonical sources
## Naming
## Time
## Standard filters
## Reconciliation
## Ownership and review
## Questions to ask before adding a metric
```

That file is yours. Mora writes it once and never rewrites it, not even under
`--force`, because everything in it is something your team decided. An agent
reads it before it asks anything, so a question you have already answered there
is one nobody gets asked again — and the fifth metric costs a lot less to agree
than the first.

## `mora connection`

A real semantic layer runs on your warehouse, and `mora connection` is how it
gets there.

```
mora connection add [name]     declare a connection and check that it works
mora connection test [name]    open each connection and see if it answers
mora connection list           what is declared, and which credentials are unset
```

`add` edits `mora.yaml` in place, as a document rather than a re-render, so the
comments and ordering your team put there survive a command that only means to add
a few lines. It then records any new `${VAR}` in `.env.example`, and finishes by
opening the connection for real:

```
$ mora connection add warehouse --type bigquery
┌   mora connection add
│
◇  Added to mora.yaml ────────────────────╮
│  warehouse  bigquery                    │
│    project_id: ${GOOGLE_CLOUD_PROJECT}  │
├─────────────────────────────────────────╯
│
●  .env.example now lists GOOGLE_CLOUD_PROJECT, so a teammate knows what to set.
│
└  warehouse is declared.
```

A credential is written as a `${VAR}` reference by default, not as a value:
`mora.yaml` is committed, and a project id or key path baked into it is one you
cannot rotate without a pull request. Pass a literal when you mean one
(`--project-id acme-prod`). Nothing is interpolated until a connection is opened,
and a reference with no value fails by name rather than falling back to whatever
credentials the machine happens to have.

Models name the connection they read from, so several can coexist:

```malloy
source: orders is duckdb.table('data/orders.csv')
source: sessions is warehouse.table('analytics.sessions')
```

`validate` and `query` open every declared connection together and let Malloy
route each source to its own, so one project can span a laptop's CSV files and a
warehouse without splitting into two.

Every prompt has a flag, so an agent can do this unattended:

```bash
mora connection add warehouse -t bigquery --project-id '${GOOGLE_CLOUD_PROJECT}' --default --json
mora connection add shop -t postgres --host db.internal --database shop --json
mora connection add exports -t duckdb --database exports.duckdb --yes
```

BigQuery authenticates with Application Default Credentials
(`gcloud auth application-default login`); point `service_account_key_path` at a
key file to use a service account instead. That login needs a browser, so it is
the one step an agent has to hand back to a human.

Postgres takes a host, a port, a database and a user, and its password is written
as `${POSTGRES_PASSWORD}`. A read-only role is enough — Mora never writes to your
database. Managed Postgres refuses an unencrypted connection, so add `--ssl true`
for Neon, Supabase or RDS. Table paths are always `schema.table`, exactly as
`mora schema` prints them: Malloy's Postgres dialect has no default schema, so a
bare name fails even where `search_path` would have resolved it.

## `mora init`

```
Usage: mora init [options] [directory]

Options:
  -n, --name <name>                    project name
  -d, --db <database>                  data source (duckdb, postgres, bigquery)
  --connection <name>                  name models will use for it
  -m, --models <dir>                   directory for Malloy models (default: metrics)
  -y, --yes                            accept defaults without prompting
  -f, --force                          overwrite existing files
  --no-test                            keep the scaffold without checking the connection
  --json                               print a machine-readable result instead of prose
  --host <value>                       Postgres: Host
  --port <value>                       Postgres: Port
  --database <value>                   Postgres: Database name
  --user <value>                       Postgres: User
  --password <value>                   Postgres: Password
  --ssl <value>                        Postgres: Require TLS (true or false)
  --project-id <value>                 BigQuery: GCP project id
  --location <value>                   BigQuery: Location
  --service-account-key-path <value>   BigQuery: Service account key file
  --billing-project-id <value>         BigQuery: Billing project id
```

DuckDB works with no configuration, which is why it is the default: point it at
local CSV, Parquet or `.duckdb` files and you have somewhere to model against in
one command. Choosing Postgres or BigQuery interactively asks for the connection
settings, writes credential values into `.env`, and tests that the warehouse
answers — so you leave the flow ready to query. The same settings are available as
flags for unattended runs; prefer `${VAR}` references so nothing about your
warehouse ends up in version control.

Models go in `metrics/`, and init does not ask: every Mora project keeping them in
the same place is worth more than the choice, and it lets the docs an agent reads
name the directory outright. Pass `--models` when a repo needs somewhere else —
that writes `project.models` in `mora.yaml`, which is what every other command
reads.

The models directory starts empty. What belongs in it is sources over your
tables, and only you and your agent know which of those are worth defining.

## Adopting a project someone else set up

A semantic layer is only worth having if the whole team shares it, so `mora init`
does something different in a directory that already has a `mora.yaml`: it sets up
your checkout instead of scaffolding over the work someone committed.

```bash
git clone git@github.com:acme/analytics.git && cd analytics
npx @moradata/cli init
```

That copies `.env.example` to a gitignored `.env`, tells you which credentials are
still empty, and compiles the committed models so you know the checkout works
before you touch anything. Models, `mora.yaml` and your team's own writing are
read-only to it. Exit code `0` means ready to use; `1` means a credential is unset
or a model failed to compile, and the report says which.

The `.env.example` is generated from the connections in `mora.yaml`, so the list of
required variables comes from the project rather than from a README someone has to
remember to update. Pass `--force` if you really do want to re-scaffold.

## What Mora owns, and what you own

Guidance for agents is split by who maintains it, so Mora refreshing its own
files never argues with a rule your team wrote:

- `.agents/modeling.md`, `.agents/malloy.md` and `.agents/mora.md` belong to
  Mora. They are rewritten whenever Mora writes them. Don't edit them.
- `AGENTS.md` is shared. Mora maintains the part between its
  `mora:begin`/`mora:end` markers and scaffolds a `## Team conventions` section
  below it. Anything outside the markers is yours.
- `metrics/conventions.md` is yours from the moment it exists. Mora scaffolds it
  once and never writes it again, so it is the place for anything about what a
  metric means; `## Team conventions` in `AGENTS.md` is for rules about working
  in the repo.
- `mora.yaml` belongs to the project. `mora connection add` edits it as a YAML
  document, preserving your comments and ordering rather than re-rendering it.

To update, update the binary (`npm i -g @moradata/cli@latest`, or
`npx @moradata/cli@latest`). Nothing in a project pins a Mora version.

## Serving these models

Mora is the authoring half of a semantic layer: it gets the models written,
checked and reviewed. Serving them to BI tools and to agents that never touch the
checkout is [Malloy Publisher](https://github.com/malloydata/publisher)'s job,
and it works against a Mora project as-is — table paths in a scaffolded model are
relative to the models directory, which is what Mora, Publisher and the VS Code
Malloy extension all resolve from.

Publisher needs two files Mora does not write: a `publisher.json` in the models
directory to make it a package, and a `publisher.config.json` listing the
packages a server should load. See its docs for the current shape of both.

## Troubleshooting

**`mora schema` lists nothing, on DuckDB.** A DuckDB connection opens whether or
not the directory it reads holds anything, so this almost always means
`working_directory` is not where the data is. The report names the directory it
walked and the directories in the project that do hold data files; set
`working_directory` on the connection in `mora.yaml` to one of those, or move the
data under the models directory. Relative table paths resolve from
`working_directory`, which defaults to `metrics/` so a model stays portable to
Malloy Publisher and the VS Code extension.

**`Connection "warehouse" needs GOOGLE_CLOUD_PROJECT, which is not set.`** A
`${VAR}` in `mora.yaml` with no value stops the command rather than falling back
to whatever credentials the machine has, because connecting to the wrong
warehouse quietly is worse than not connecting. Put the value in `.env` (which is
gitignored) or in your environment. `mora connection list` shows every declared
connection with the variables it needs and whether each one is set.

**BigQuery refuses to authenticate, or cannot detect a project.** BigQuery uses
Application Default Credentials, so a fresh machine needs
`gcloud auth application-default login` — a browser step, and the one part of
setup an agent has to hand back to a human. Use a service account instead by
pointing `service_account_key_path` at a key file. "Unable to detect a project id"
means `project_id` is unset or resolved to nothing; set it, and Mora bills against
it too unless `billing_project_id` says otherwise.

**Postgres rejects a table name that exists.** Malloy's Postgres dialect has no
default schema, so `orders` fails and `public.orders` works, even though
`search_path` would have found the first. `mora schema` prints every name
qualified for exactly this reason. A managed Postgres that closes the connection
instead needs TLS: set `ssl: true` on the connection in `mora.yaml`.

**`mora schema` on BigQuery returns fewer datasets than you expect.** The
region-wide listing needs `bigquery.tables.list` across every dataset in the
project. Without it, Mora falls back to the datasets your credentials can actually
see, which is the honest answer rather than nothing. If even that is denied, the
error names the role to ask for: `roles/bigquery.metadataViewer`.

**`mora init` printed nothing and exited 3.** It refuses to overwrite files it did
not write. The error lists them; `--force` re-scaffolds Mora's own output, and
leaves `metrics/conventions.md` and anything outside the `mora:begin`/`mora:end`
markers in `AGENTS.md` alone.

**A fresh clone fails `mora init`, and the models are fine.** Join mode compiles
the committed models against your credentials, so a failure there is usually data
that is not reachable from your machine rather than a broken model. Check the
credentials it listed first, then whether your connection can see the tables the
models read.

**`mora validate` passes and `mora query` fails.** Compiling proves the columns
exist; running proves the database will do the work. A permission error on a
specific table, a query that times out, or a type the driver will not cast are all
things only execution can find. The error is the database's own, reported verbatim.

## Roadmap

In rough order:

- **Depth in the modelling loop.** More of the checks in `.agents/modeling.md`
  worth running as one command, and better evidence in the pull request an agent
  opens. This is the part of Mora that is actually its own.
- **More warehouses.** DuckDB, Postgres and BigQuery work today; Snowflake and
  Trino are drivers Malloy already has, and each is a connection type away.
- **MCP over the loop** — `schema`, `query` and `validate` against a checkout,
  for agents that prefer tools to shell commands.

## Development

Requires Node 20.11 or newer.

```bash
npm install
npm run build      # bundle the CLI to dist/
npm test           # unit tests plus a real DuckDB compile
npm run typecheck
npm run lint
```

Try the CLI without installing it globally:

```bash
node dist/cli.js init /tmp/demo --yes --json
node dist/cli.js schema -C /tmp/demo
node dist/cli.js validate /tmp/demo --json
```

## License

MIT

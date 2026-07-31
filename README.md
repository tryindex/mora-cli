# Mora

**Build and manage a semantic layer your agent can query with confidence.**

Coding agents are good at writing SQL and bad at being trusted with it. Every
question gets a fresh query, every query re-derives what "revenue" or "active
customer" means, and nobody notices when two answers quietly disagree.

Mora moves those definitions into a version-controlled semantic layer built on
[Malloy](https://malloydata.dev). Dimensions, measures and joins are declared
once, reviewed like any other code, and composed into queries. An agent stops
inventing logic and starts using a vocabulary — and a human can check an answer
by reading a few lines of a model instead of auditing a wall of SQL.

Mora is a CLI, so any agent that can run a command can use it: Cursor, Claude
Code, Codex, or your own.

> **Status: early.** `mora init`, `mora upgrade`, `mora connection`, `mora validate`,
> `mora describe` and `mora query` work against DuckDB and BigQuery today. See
> [Roadmap](#roadmap) for what is next.

## Quick start

```bash
npx @moradata/cli init
```

That walks you through naming the project and connecting to your data, then
writes a semantic layer into the current directory:

```
mora.yaml               # models directory + the connection you just set up
metrics/                # your models go here; it starts empty
AGENTS.md               # the rules your agent must follow, plus your own
.agents/
  malloy.md             # how to write Malloy, loaded when editing a model
  modeling.md           # how to turn an unmodelled warehouse into a first draft
  mora.md               # the commands, their flags and their output
.env.example            # which credentials the project needs, if any
```

Those files are meant to be committed. When a teammate clones the repo and runs
the same command, Mora sets up their checkout instead of scaffolding again — see
[Adopting a project someone else set up](#adopting-a-project-someone-else-set-up).

Before finishing, `init` opens the connection. If the database does not answer,
the scaffold is removed again and your directory is left exactly as it was: a
project whose connection has never worked is not worth keeping, and every later
command would fail on it. Fix the setting or the credential and run `init` again.

Mora writes no models and no sample data. What belongs in `metrics/` is sources
over your own tables, so the loop starts by looking at them:

```bash
mora schema                         # what the connection can actually read
mora describe                       # what the vocabulary already contains
mora validate                       # after any edit to a model
mora query revenue_by_month         # run a definition someone reviewed
```

Point your agent at `.agents/modeling.md` and it will read the warehouse, check
its assumptions against the data, and propose a first set of sources for you to
review.

To read from somewhere else as well, add a second connection:

```bash
mora connection add warehouse --type bigquery
```

## Designed for agents

Interactive prompts are the fallback, not the interface. Every prompt has a flag
so an agent can run Mora unattended:

```bash
mora init ./analytics --db duckdb --name analytics --yes --json
```

- `--yes` never prompts; `--json` implies it and prints a structured result.
- `--json` output includes every file written, the connection check, and
  suggested next steps.
- Exit codes are meaningful: `0` success, `1` failure, `2` bad usage, `3` refused
  because files already exist.

`init` also writes an `AGENTS.md` into your project. Cursor and Claude Code read
it automatically; it tells the agent to compose existing measures, to extend the
model rather than inline logic into one-off queries, and never to reach around
the semantic layer with raw SQL. The longer references it points at live in
`.agents/`, so they are read when they are needed rather than on every request:
how to write Malloy here, what each `mora` command reports, and — for the case
where the question is about a table nobody has modelled yet — how to go from a
warehouse to a reviewable first draft of a semantic layer.

## `mora init`

```
Usage: mora init [options] [directory]

Options:
  -n, --name <name>                    project name
  -d, --db <database>                  data source (duckdb, bigquery)
  --connection <name>                  name models will use for it (default: the database)
  -m, --models <dir>                   directory for Malloy models (default: metrics)
  -y, --yes                            accept defaults without prompting
  -f, --force                          overwrite existing files
  --no-test                            keep the scaffold without checking the connection
  --project-id <value>                 BigQuery: GCP project id
  --location <value>                   BigQuery: location
  --service-account-key-path <value>   BigQuery: service account key file
  --billing-project-id <value>         BigQuery: billing project id
  --json                               print a machine-readable result instead of prose
```

`init` declares exactly one connection: the one you picked. DuckDB needs no
configuration — point it at local CSV, Parquet or `.duckdb` files and you have a
semantic layer in one command. Choosing BigQuery asks for the connection
settings and writes credential values into `.env`. If you have run
`gcloud auth application-default login`, those credentials are offered as the
default and you pick the project from a searchable list of the ones you can
actually query — narrowed to the ones holding data when you have access to many —
so setup is two confirmations. The same settings are available as flags for
unattended runs; prefer `${VAR}` references so nothing about your warehouse ends
up in version control. Add more connections later with
[`mora connection add`](#mora-connection).

Then it opens the connection, and **a scaffold whose connection does not answer
is deleted again.** `--json` reports `rolledBack: true` with an empty `files`,
and the directory is left as it was found — including any file `--force` would
have overwritten. Nothing is half-written for you to clean up, and there is no
project whose first real command fails. `--no-test` skips the check and keeps the
scaffold, which is what to pass when the credential will only exist later.

`metrics/` starts empty. Mora ships no example model and no sample data: a
worked example over a fixture table models data you do not have, and the thing
that actually gets you to a first source is `mora schema` plus
`.agents/modeling.md`, which describe your warehouse rather than someone else's.

Models go in `metrics/`, and init does not ask: every Mora project keeping them in
the same place is worth more than the choice, and it lets the docs an agent reads
name the directory outright. Pass `--models` when a repo needs somewhere else —
that writes `project.models` in `mora.yaml`, which is what every other command
reads.

## `mora connection`

`init` sets up the first connection. `mora connection` is how a project gains
another one, and how you check that any of them still answer.

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
source: exports is duckdb.table('data/exports.csv')
source: sessions is warehouse.table('analytics.sessions')
```

`validate`, `describe` and `query` open every declared connection together and let
Malloy route each source to its own, so one project can span a laptop's CSV files
and a warehouse without splitting into two.

Every prompt has a flag, so an agent can do this unattended:

```bash
mora connection add warehouse -t bigquery --project-id '${GOOGLE_CLOUD_PROJECT}' --default --json
mora connection add exports -t duckdb --database exports.duckdb --yes
```

BigQuery authenticates with Application Default Credentials
(`gcloud auth application-default login`); point `service_account_key_path` at a
key file to use a service account instead. Interactively, Mora reads your gcloud
state and offers what you are already signed in with: it confirms the account and
skips the key file prompt when you accept. If you have never logged in, it says
which command to run.

Rather than asking you to recall a project id, it then lists the projects those
credentials can actually run BigQuery in — type to search by name or id, and the
project your gcloud configuration points at is preselected so Enter accepts it.
Large organisations are paged through transparently; if the list is cut short, or
the project you want is not on it, choose `Enter a project id by hand` to type one
(including a `${VAR}` reference). Nothing here changes unattended runs: with
`--yes` or `--json` Mora makes no network calls and writes the same `mora.yaml` on
every machine.

Google returns every project you hold a role on, which in an organisation is
mostly projects that have never used BigQuery. So when the list runs past about
twenty-five, Mora checks which of them hold a dataset you can read and offers
those — a connection to a project with no datasets opens successfully and can
answer nothing. The check takes a second or two and the full list stays one
option away, under `Show all N projects`. If it cannot tell (no permission to list
datasets, or too many projects to check quickly), every project is offered rather
than a shortlist that might be missing yours.

Adding a connection here does not make it usable by a Publisher server, which
keeps its own connection config. See [`mora plugin`](#mora-plugin).

## `mora validate`

```
Usage: mora validate [options] [directory]

Options:
  --json               print a machine-readable result instead of prose
```

`validate` reads `mora.yaml`, finds every `.malloy` file under the models
directory, and compiles each one. Run it after editing a model: it is the check
that keeps a semantic layer honest, because Malloy resolves table schemas at
compile time, so a pass means the model parses *and* the referenced columns
really exist.

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
queries, compile duration and error text, which is the form an agent should use.
A model reading from a connection type Mora has no driver for says so, rather
than passing quietly.

## `mora describe`

```
Usage: mora describe [options] [pattern]

Options:
  -C, --directory <dir>  project directory (default: .)
  --json                 print a machine-readable result instead of prose
```

`describe` is how an agent learns the vocabulary without reading every file. It
lists each source with its measures, dimensions, views and joins, plus the named
queries that can be run directly:

```
$ mora describe revenue
┌   mora describe
│
◇  orders  metrics/orders.malloy ───────────────────────────────────────╮
│  One row per order, with the customer and region that placed it.      │
│  measures                                                             │
│    revenue  number                                                    │
│      Total order amount, including orders that are not yet completed. │
│    average_order_value  number                                        │
│      Mean order amount. Skewed by large orders, so read it next to r… │
│  views                                                                │
│    revenue_by_month  view                                             │
│      Revenue and order count for each month.                          │
├───────────────────────────────────────────────────────────────────────╯
│
└  1 source, 2 measures, 0 dimensions, 3 views, 3 named queries.
```

Each definition arrives with its doc string, because a measure someone is about
to trust should say what it excludes. The optional pattern matches names *and*
descriptions, case-insensitively, keeping the source each match belongs to — so
`mora describe refund` finds the measure documented as excluding refunds even
when its name never says so. Searching and dumping are the same operation over
the same index, which is also the index `mora query` resolves a name against, so
anything `describe` lists can be run.

## `mora query`

```
Usage: mora query [options] [name]

Options:
  -e, --expr <malloy>    run Malloy the model does not define
  -C, --directory <dir>  project directory (default: .)
  --sql                  print the generated SQL without running it
  -l, --limit <n>        largest number of rows to return (default: 50)
  --json                 print a machine-readable result instead of prose
```

A name runs a definition someone committed and reviewed — either a `query:`
declaration or a view, written as `source.view`:

```bash
mora query revenue_by_month
mora query orders.revenue_by_month --limit 12
```

Every result comes with the SQL that produced it, so a human can audit how an
answer was reached rather than taking the number on faith. `--sql` prints that
SQL without executing anything.

`--expr` runs Malloy that is not in the model:

```bash
mora query -e "orders -> { aggregate: revenue }"
```

That result is marked `reviewed: false` and carries a visible warning. Ad-hoc
Malloy is allowed on purpose — forbidding it would just push an agent back to raw
SQL — but the output nudges toward promoting anything worth keeping into a named
definition, where a pull request can catch a mistake before a dashboard does.

`--expr` takes a whole Malloy document rather than just a query, which is what
lets it read a table no model mentions yet:

```bash
mora query -e "source: probe is duckdb.table('data/orders.csv') extend {}
run: probe -> { group_by: status; aggregate: rows is count() }"
```

That works in a project with nothing in `metrics/` at all, which matters because
checking the data is the first step of modelling it, not something to do
afterwards.

`--json` reports `{ ok, command, name, reviewed, model, sql, executed, rows,
rowCount, truncated, nextSteps }`. An unknown name exits `1` and lists the names
that do exist.

## `mora schema`

```
Usage: mora schema [options] [tables...]

Options:
  -c, --connection <name>  connection to read (default: the project default)
  -C, --directory <dir>    project directory (default: .)
  --pattern <text>         only list tables whose name contains this text
  --json                   print a machine-readable result instead of prose
```

Where `describe` shows the semantic layer, `schema` shows the warehouse behind
it. It answers the question an agent hits the moment it is asked about data
nobody has modelled: what is even in here?

Run it with no argument first. The listing is where valid table names come from,
so nothing has to be guessed, and every name it prints goes inside
`<connection>.table('...')` unchanged:

```
$ mora schema
┌   mora schema
│
◇  Tables in duckdb duckdb ─╮
│    data/orders.csv  file  │
├───────────────────────────╯
│
└  1 table
```

Then read the columns, naming as many tables as you want in one pass:

```bash
mora schema data/orders.csv
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
connection's working directory. A BigQuery connection lists the whole project
where it is allowed to, and otherwise falls back to the datasets your credentials
can actually see — being told nothing because most of the project is none of your
business is not an answer. If even that is denied, the error names the role to ask
for.

Seeing a table is not the same as understanding it. A schema cannot tell you
whether a key has duplicates, whether a foreign key is unique on the other side,
or whether `total` includes tax — and each of those changes the model. That is
what `.agents/modeling.md` is for: Mora scaffolds it alongside the other agent
docs, and it walks an agent from `mora schema` through checking those assumptions
with `mora query -e` to a scope agreed with a human and a pull request full of
documented definitions.

## Adopting a project someone else set up

A semantic layer is only worth having if the whole team shares it, so `mora init`
does something different in a directory that already has a `mora.yaml`: it sets up
your checkout instead of scaffolding over the work someone committed.

```bash
git clone git@github.com:acme/analytics.git && cd analytics
npx @moradata/cli init
```

That copies `.env.example` to a gitignored `.env`, tells you which credentials are
still empty, notes when the project needs `mora upgrade` (or a newer CLI), lists
the plugins the project uses and whether each is installed here, and compiles the
committed models so you know the checkout works before you touch anything.
Models, `mora.yaml` and your team's own writing are read-only to it. Exit code `0`
means ready to use; `1` means a credential is unset or a model failed to compile,
and the report says which.

The `.env.example` is generated from the connections in `mora.yaml`, so the list of
required variables comes from the project rather than from a README someone has to
remember to update. Pass `--force` if you really do want to re-scaffold.

## Updating

Updating is two steps. The binary and the project are versioned separately on
purpose: teammates upgrade the project through a pull request, like any other
change to the semantic layer.

1. **Update the binary.** One-off: `npx @moradata/cli@latest …`. Installed:
   `npm i -g @moradata/cli@latest`. Mora also prints a one-line nudge on stderr
   when a newer version is on npm (cached for a day; silent under `--json`, `CI`,
   or `MORA_NO_UPDATE_CHECK`).
2. **Update the project.** In the checkout, run:

```bash
mora upgrade
```

That refreshes `.agents/malloy.md` and `.agents/mora.md`, rewrites the managed
block in `AGENTS.md`, applies any `mora.yaml` migrations, and stamps
`cli_version` in `mora.yaml`. Review the diff and commit it. `--check` reports
whether an upgrade is pending without writing (exit `0` when current, `1` when
pending), which is the form CI should use.

The stamp is the project's source of truth for which Mora the team is on. A
teammate whose CLI is *older* than the stamp is told to update the binary rather
than silently rewriting committed docs backwards. A missing stamp (projects
scaffolded before this existed) is treated as an upgrade pending.

### What Mora owns, and what you own

Guidance for agents is split by who maintains it, so upgrading never argues with
a rule your team wrote:

- `.agents/malloy.md`, `.agents/modeling.md` and `.agents/mora.md` belong to
  Mora. They are replaced wholesale by `mora upgrade`, which also adds a guide a
  project is missing because it was scaffolded before that guide existed. Don't
  edit them.
- `AGENTS.md` is shared. Mora maintains the part between its
  `mora:begin`/`mora:end` markers and scaffolds a `## Team conventions` section
  below it. Anything outside the markers is yours and survives upgrades.

The same split applies to configuration: `mora.yaml` and anything a plugin writes
are created once and then belong to the project, so adding a connection or an
environment is never undone by a later `mora init`.
`mora connection add` and `mora upgrade` are the exceptions that prove it — they
edit `mora.yaml` as a document, leaving every comment and every other connection
where they were.

## What a model looks like

Mora does not write this for you — it is what you or your agent puts in
`metrics/` once `mora schema` has said what the tables are.

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

query: revenue_by_month is orders -> revenue_by_month
```

`revenue` is now defined in exactly one place. Every query that uses it, whether
written by you or by an agent, means the same thing.

The `#"` lines are doc strings, and they are part of the model rather than
comments on it. `mora describe` prints them, searches them, and a served model
hands them to whoever is asking — so a definition arrives with the caveats that
make it safe to use.

## `mora plugin`

A plugin sets up one integration and nothing else. Everything a project does not
need stays out of it, so a scaffold is the semantic layer and nothing more.

```bash
mora plugin list                    # what Mora offers, and what this project uses
mora plugin add publisher           # set an integration up
mora plugin remove publisher        # take it back out
```

Adding writes the files the integration needs, records the plugin in `mora.yaml`,
and notes it in the managed block of `AGENTS.md`. Commit the result: the files
belong to the project from that moment, and Mora will not rewrite them.

Removing deletes only the files the plugin would write today. If one of them has
been edited since, the command refuses and writes *nothing* — a failed remove
never leaves a project half changed. Pass `--force` to delete them anyway, or
`--keep-files` to keep the files and only stop tracking the plugin.

Mora ships with `publisher`. Anything else is an npm package named
`mora-plugin-<name>`, installed per checkout into the gitignored
`.mora/plugins/`, which is why a fresh clone is told to run `mora plugin add`
rather than having a package fetched behind its back. A plugin package
default-exports `{ name, description, setup }`, where `setup` returns the files to
write; the same function is what `remove` consults to learn what to delete, so
there is no teardown to keep in sync.

### Serve it with Publisher

Mora is the authoring half of a semantic layer: it scaffolds the models, keeps
them compiling, and puts every change to a definition through code review.
[Malloy Publisher](https://github.com/malloydata/publisher) is the serving half:
point it at a merged repo and it exposes the same models over REST and MCP, to
BI tools, applications, and agents that never touch the checkout.

```bash
mora plugin add publisher
npx @malloy-publisher/server --server_root .
```

The plugin writes `metrics/publisher.json`, which makes the models directory a
package, and `publisher.config.json`, which lists the packages a server should
load. A DuckDB connection resolves relative table paths from `metrics/`, which is
what Publisher resolves a package's paths from too, so the same `.malloy` file
works in the CLI, in the VS Code Malloy extension, and on a server.

Both files are yours once written — add warehouse connections and environments to
`publisher.config.json` freely. A Publisher server keeps its own connection
config, so a served project can read from a different warehouse than your laptop
does.

## `mora upgrade`

```
Usage: mora upgrade [options] [directory]

Options:
  --check              report whether an upgrade is pending without writing
  -y, --yes            run without prompting (implied by --json)
  --json               print a machine-readable result instead of prose
```

See [Updating](#updating) for the two-step pattern. `--json` reports
`{ ok, command, status, fromVersion, toVersion, configVersion, migrations,
files, nextSteps }`.

## Roadmap

- More warehouses. DuckDB and BigQuery work today; Snowflake, Postgres and
  Trino are the drivers Malloy already has, and each is a connection type away.
- `mora describe` growing from substring matching over names and doc strings into
  real retrieval, so an agent can find a definition by meaning. Searching the
  warehouse schema is a separate problem, and `mora schema` is where it lives.
- MCP over the development loop — `validate`, `describe`, `schema` and `query`
  against a checkout, for agents that prefer tools to shell commands. Serving
  finished models over MCP is Publisher's job, and stays there.
- More plugins, and third-party ones worth naming here. The interface is
  deliberately small (`setup` returns files); it will grow only where a real
  integration cannot be expressed.

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
node dist/cli.js init /tmp/demo --yes --json     # empty metrics/, one duckdb connection
node dist/cli.js schema -C /tmp/demo --json
node dist/cli.js validate /tmp/demo --json
```

A fresh project has no models, so write one before exercising `describe` and
`query`. `test/helpers/fixtures.ts` has the orders model and CSV the test suite
uses:

```bash
node dist/cli.js describe -C /tmp/demo
node dist/cli.js query orders.revenue_by_month -C /tmp/demo
```

To check that such a project is still servable, add the Publisher plugin, run
Publisher against it, and query the same definition through its API. The two
should agree:

```bash
cd /tmp/demo && node ../path/to/mora-cli/dist/cli.js plugin add publisher --json
npx @malloy-publisher/server --server_root .
curl -X POST -H 'Content-Type: application/json' -d '{"queryName":"revenue_by_month"}' \
  http://localhost:4000/api/v0/environments/default/packages/demo/models/orders.malloy/query
```

## License

MIT

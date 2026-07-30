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

> **Status: early.** `mora init`, `mora validate`, `mora describe` and `mora query`
> work against DuckDB today. A real BigQuery connection is next — see
> [Roadmap](#roadmap).

## Quick start

```bash
npx @moralabs/cli init
```

That walks you through naming the project and picking a data source, then writes
a working semantic layer into the current directory:

```
mora.yaml               # models directory + database connections
semantic/
  example.malloy        # a source with dimensions, measures and views
  data/orders.csv       # sample data, so the example runs immediately
AGENTS.md               # the rules your agent must follow, plus your own
.agents/
  malloy.md             # how to write Malloy, loaded when editing a model
  mora.md               # the commands, their flags and their output
.env.example            # which credentials the project needs, if any
```

Those files are meant to be committed. When a teammate clones the repo and runs
the same command, Mora sets up their checkout instead of scaffolding again — see
[Adopting a project someone else set up](#adopting-a-project-someone-else-set-up).

Before finishing, `init` compiles the example against DuckDB. Because Malloy
resolves table schemas at compile time, a pass means the model parses *and* the
data really has the columns it references.

From there the loop is three commands:

```bash
mora describe                       # what the vocabulary already contains
mora query monthly_revenue          # run a definition someone reviewed
mora validate                       # after any edit to a model
```

## Designed for agents

Interactive prompts are the fallback, not the interface. Every prompt has a flag
so an agent can run Mora unattended:

```bash
mora init ./analytics --db duckdb --name analytics --yes --json
```

- `--yes` never prompts; `--json` implies it and prints a structured result.
- `--json` output includes every file written, the compile result, and suggested
  next steps.
- Exit codes are meaningful: `0` success, `1` failure, `2` bad usage, `3` refused
  because files already exist.

`init` also writes an `AGENTS.md` into your project. Cursor and Claude Code read
it automatically; it tells the agent to compose existing measures, to extend the
model rather than inline logic into one-off queries, and never to reach around
the semantic layer with raw SQL. The longer references it points at live in
`.agents/`, so they are read when they are needed rather than on every request.

## `mora init`

```
Usage: mora init [options] [directory]

Options:
  -n, --name <name>    project name
  -d, --db <database>  data source (duckdb, bigquery)
  -m, --models <dir>   directory for Malloy models (default: semantic)
  --no-example         skip the example model and its sample data
  -y, --yes            accept defaults without prompting
  -f, --force          overwrite existing files
  --no-compile         skip the Malloy compile check
  --json               print a machine-readable result instead of prose
```

DuckDB works with no configuration, which is why it is the default: point it at
local CSV, Parquet or `.duckdb` files and you have a semantic layer in one
command. Choosing BigQuery writes a connection block that reads
`${GOOGLE_CLOUD_PROJECT}` from the environment, so nothing about your warehouse
ends up in version control. The DuckDB connection is always included, so a
project always has one connection that works.

BigQuery is a configuration placeholder for now: the block is written and its
credentials are checked, but queries still run against DuckDB. Wiring up the real
connection is the next milestone.

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
│    pass semantic/example.malloy  1 source, 3 named queries  │
├─────────────────────────────────────────────────────────────╯
│
└  1 model compiled against duckdb.
```

Exit code `0` means every model compiled, `1` means at least one failed or the
project could not be read. `--json` reports each model with its sources, named
queries, compile duration and error text, which is the form an agent should use.
Only DuckDB connections can be compiled today, so a model reading from a
warehouse connection reports that rather than passing quietly.

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
◇  orders  semantic/example.malloy ─╮
│  measures                         │
│    revenue  number                │
│    average_order_value  number    │
│  views                            │
│    revenue_by_month  view         │
│    revenue_by_region  view        │
├───────────────────────────────────╯
│
└  1 source, 2 measures, 0 dimensions, 2 views, 0 named queries.
```

The optional pattern filters names case-insensitively, keeping the source each
match belongs to. Searching and dumping are the same operation over the same
index, which is also the index `mora query` resolves a name against — so
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
mora query monthly_revenue
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

`--json` reports `{ ok, command, name, reviewed, model, sql, executed, rows,
rowCount, truncated, nextSteps }`. An unknown name exits `1` and lists the names
that do exist.

## Adopting a project someone else set up

A semantic layer is only worth having if the whole team shares it, so `mora init`
does something different in a directory that already has a `mora.yaml`: it sets up
your checkout instead of scaffolding over the work someone committed.

```bash
git clone git@github.com:acme/analytics.git && cd analytics
npx @moralabs/cli init
```

That copies `.env.example` to a gitignored `.env`, tells you which credentials are
still empty, refreshes the docs Mora owns in `.agents/`, and compiles the committed
models so you know the checkout works before you touch anything. Models, `mora.yaml`
and your team's own writing are read-only to it. Exit code `0` means ready to use;
`1` means a credential is unset or a model failed to compile, and the report says
which.

The `.env.example` is generated from the connections in `mora.yaml`, so the list of
required variables comes from the project rather than from a README someone has to
remember to update. Pass `--force` if you really do want to re-scaffold.

### What Mora owns, and what you own

Guidance for agents is split by who maintains it, so upgrading the CLI never
argues with a rule your team wrote:

- `.agents/malloy.md` and `.agents/mora.md` belong to Mora. They are replaced
  wholesale on every `mora init`, which is what keeps a checkout from being frozen
  at whichever version of the guidance scaffolded it. Don't edit them.
- `AGENTS.md` is shared. Mora maintains the part between its
  `mora:begin`/`mora:end` markers and scaffolds a `## Team conventions` section
  below it. Anything outside the markers is yours and survives upgrades.

## What a model looks like

```malloy
source: orders is duckdb.table('orders.csv') extend {
  primary_key: id

  dimension:
    ordered_at is order_date::date
    is_large_order is amount > 500

  measure:
    order_count is count()
    revenue is amount.sum()

  view: revenue_by_month is {
    group_by: ordered_at.month
    aggregate: revenue, order_count
  }
}

query: monthly_revenue is orders -> revenue_by_month
```

`revenue` is now defined in exactly one place. Every query that uses it, whether
written by you or by an agent, means the same thing.

## Roadmap

- A real BigQuery connection, so `validate`, `describe` and `query` run against
  the warehouse instead of only DuckDB.
- Semantic search over the model, for finding a definition by meaning rather than
  by substring.
- MCP server mode, for agents that prefer tools over shell commands.

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
node dist/cli.js validate /tmp/demo --json
node dist/cli.js describe -C /tmp/demo
node dist/cli.js query monthly_revenue -C /tmp/demo
```

## License

MIT

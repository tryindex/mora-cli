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

> **Status: early.** `mora init` scaffolds a project today. Query execution and
> model validation are next — see [Roadmap](#roadmap).

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
AGENTS.md               # how your agent should use the semantic layer
```

Before finishing, `init` compiles the example against DuckDB. Because Malloy
resolves table schemas at compile time, a pass means the model parses *and* the
data really has the columns it references.

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
the semantic layer with raw SQL.

## `mora init`

```
Usage: mora init [options] [directory]

Options:
  -n, --name <name>    project name
  -d, --db <database>  data source (duckdb, bigquery, postgres, snowflake)
  -m, --models <dir>   directory for Malloy models (default: semantic)
  --no-example         skip the example model and its sample data
  -y, --yes            accept defaults without prompting
  -f, --force          overwrite existing files
  --no-compile         skip the Malloy compile check
  --json               print a machine-readable result instead of prose
```

DuckDB works with no configuration, which is why it is the default: point it at
local CSV, Parquet or `.duckdb` files and you have a semantic layer in one
command. Choosing BigQuery, PostgreSQL or Snowflake writes a connection block
with placeholder values and `${VAR}` references for credentials, so secrets stay
out of version control. The DuckDB connection is always included, so a project
always has one connection that works.

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

- `mora validate` — compile every model in the project as a standalone check.
- `mora query` — run named queries and ad-hoc Malloy, with results shaped for an
  agent to read.
- `mora describe` — dump the model's sources, dimensions and measures so an agent
  can discover the vocabulary without reading every file.
- Connection implementations for BigQuery, PostgreSQL and Snowflake.
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
```

## License

MIT

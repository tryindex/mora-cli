# Working on Mora

This file is for whoever is building the Mora CLI — human or agent. It records
what Mora is for, the principles that decide arguments, and where it is going, so
a change can be judged against something more durable than the last thing
someone said in a chat. Read it before making a change of any size. If a change
contradicts it, say so and change this file in the same commit.

> **Not to be confused with the shipped `AGENTS.md`.** Mora scaffolds an
> `AGENTS.md` into a *user's* project, rendered by
> [`src/templates/agents-doc.ts`](src/templates/agents-doc.ts). That file tells an
> agent how to use a semantic layer. This file tells you how to build the tool.
> They are different documents with the same name; do not edit one thinking it is
> the other.

## The problem

Coding agents write SQL well and cannot be trusted with it. Every question gets a
fresh query, every query re-derives what "revenue" or "active customer" means,
and nobody notices when two answers quietly disagree. The failure is not bad SQL.
It is that the definitions live nowhere, so nothing can be reviewed and no answer
can be audited without reading the whole query.

## What Mora is

Mora moves those definitions into a version-controlled semantic layer built on
[Malloy](https://malloydata.dev), and gives agents a command line for using it.
Dimensions, measures and joins are declared once, reviewed like any other code,
and composed into queries.

Three consequences follow, and they are the whole design:

1. **A pull request is the trust mechanism.** A definition is trustworthy because
   a human approved it, not because the tool is clever. Everything Mora does
   should make a change to a definition easier to review.
2. **The vocabulary is discoverable.** An agent cannot compose definitions it
   cannot find, so `mora describe` is as important as `mora query`.
3. **The interface is a CLI.** Any agent that can run a command can use Mora —
   Cursor, Claude Code, Codex, or something nobody has written yet. That is worth
   more than a nicer integration with any one of them.

## What Mora is not

Mora is the **authoring** half of a semantic layer. Deliberately out of scope:

- **Serving models.** [Malloy Publisher](https://github.com/malloydata/publisher)
  exposes models over REST and MCP to BI tools and applications. `mora plugin add
  publisher` writes the files Publisher needs and otherwise stays out of its way.
  We do not build a server, and we do not edit `publisher.config.json` after
  writing it.
- **Being a BI tool.** No dashboards, no charts, no saved-report management.
  `mora query` prints rows so an answer can be checked, not so it can be
  presented.
- **A DSL of our own.** Models are Malloy. If Malloy needs a feature, the fix
  belongs upstream, not in a Mora abstraction that hides it.
- **Warehouse management.** Mora reads. It does not migrate schemas, load data,
  or schedule anything.

Composing with the ecosystem beats competing with it. A model written for Mora
must also work in the VS Code Malloy extension and on a Publisher server —
that constraint is why table paths resolve from the models directory.

## Who is on the other end

Three readers, and a change should be checked against all of them:

- **The person who sets it up.** Usually a head of data, running `mora init`
  once. Their job is to get something real committed on the first afternoon.
- **The teammate who clones it.** Runs `mora init` in a repo that already has a
  `mora.yaml` and needs their checkout working without asking anyone what to
  install or which variable to set. This is why `init` has two modes.
- **The agent.** Reads `--json`, branches on exit codes, and never sees a prompt.
  It has no memory of the last session and no patience for ambiguity.

## Principles

**Every prompt has a flag.** Interactive prompts are the fallback, not the
interface. If a command asks a question, it takes a flag for the same answer, and
`--json` implies `--yes`. A command that can only be driven by a human is a bug.

**Exit codes and reports are a contract.** `0` success, `1` failure, `2` bad
usage, `3` refused because files exist. The `--json` shape is an API: adding a
field is fine, changing the meaning of one is a breaking change. `executed` exists
separately from `rows` precisely because an empty result and a query that never
ran must not look alike.

**Fail honestly, and name the thing.** Never guess, never half-succeed. An unset
credential reports which variable, for which connection. Unresolved `${VAR}`
refuses rather than falling back to ambient credentials, because connecting to
the wrong warehouse silently is worse than not connecting. Distinguish "your model
is wrong" from "the tool could not run": a broken model is a per-model failure in
the report, an unopenable connection is one error for the whole command.

**Reviewed and unreviewed are different things.** `mora query <name>` runs logic
someone approved; `-e` runs logic nobody has. The result says which, and the
guidance tells agents to promote anything worth keeping into a named definition.
Never blur this to make output tidier.

**Definitions explain themselves.** `#"` doc strings are part of the model, not
comments on it, so they travel to `describe`, to search, and to a served model. A
definition arrives with the caveats that make it safe to use, or it invites
someone to re-derive it by hand.

**Committed files never hold secrets.** `mora.yaml` is committed, so credentials
go in as `${VAR}` and resolve only when a connection opens. `.env.example` records
which variables a project needs; `.env` holds values and is gitignored. When in
doubt, write the reference.

**Own little, and own it visibly.** Upgrading must never argue with a team's
writing. `.agents/*.md` belongs to Mora and is replaced wholesale by
`mora upgrade`. `AGENTS.md` is shared through `mora:begin`/`mora:end` markers,
with the team's section outside them. `mora.yaml` belongs to the project — which
is why `mora connection add` and `mora upgrade` edit it as a YAML document,
preserving comments, rather than re-rendering it. The `cli_version` stamp makes
the *project* the source of truth for which Mora the team is on, so a teammate
on an older CLI is told to update rather than rewriting committed docs backwards.

**Convention over configuration.** Models go in `metrics/`, and `init` does not
ask. Every Mora project keeping them in the same place is worth more than the
choice, and it lets the docs an agent reads name the directory outright. Escape
hatches stay (`--models`), but they are not prompts.

**A scaffold is the semantic layer, and nothing else.** Anything a project might
not need is a plugin it opts into with `mora plugin add`, not a file `init`
writes on the chance it is wanted. What Mora installs, it must also be able to
remove cleanly: `remove` re-runs a plugin's `setup` to learn what it owns and
what it looked like untouched, which is why there is no separate teardown to
drift out of sync.

**Working in one command.** DuckDB and a sample CSV mean a fresh project compiles
and answers a question before any credential exists. Never let the empty state
require setup.

## Architecture

```
src/cli.ts            registers commands, renders top-level failures
src/commands/*.ts     one file per command: flags, prompts, prose, JSON report
src/malloy/*.ts       the only code that imports Malloy
src/plugins/*.ts      the plugin interface, the built-ins, and the loader
src/templates/*.ts    pure render functions, no I/O
src/*.ts              domain: config, connections, env, scaffold, migrate,
                      version, update-check, project, errors, databases
```

Rules that keep the layers honest:

- **Only `src/malloy/` imports `@malloydata/*`,** and it imports them lazily
  through `loadMalloy`/`loadDuckDb`/`loadBigQuery`. The drivers pull in native and
  wasm bundles; `mora --help` must not pay for them, and a BigQuery-free project
  must not load Google's client libraries.
- **Templates render strings.** They take options and return text. No file reads,
  no `process.env`, no clock. That is what makes them testable by assertion on
  their output.
- **Commands do not parse.** A command file reads flags, calls domain functions,
  and formats the result. YAML parsing lives in `config.ts`, YAML *editing* in
  `connections.ts` and `plugins/config.ts`, environment resolution in `env.ts`. If
  a command starts reaching for `yaml`, the logic belongs one layer down.
- **`openProject` is the front door.** Commands that touch models load through it,
  so `validate`, `describe` and `query` fail identically on the same problems.
- **The connection registry is one place.** `src/databases.ts` declares what each
  database needs; prompts, CLI flags and the YAML that gets written all derive
  from it, so they cannot drift.
- **Third-party plugin code runs only when someone names it.** `mora plugin add
  <name>` is the one command that may install and import a package. Nothing else
  imports from `.mora/plugins/` — notably not `mora upgrade`, which renders
  AGENTS.md and must not execute a package to do it. That is why `agentsNote` is
  honoured for built-ins only.

## Anatomy of a command

Every command has the same two halves, and it matters:

```ts
export function registerFooCommand(program: Command): void { /* flags, help */ }
export async function runFoo(...): Promise<FooReport> { /* work, returns report */ }
```

- `run*` returns a typed report rather than exiting. The one exception is a
  cancelled interactive prompt, which exits `0` on the spot because there is no
  report to return and the reader chose to stop.
- The report *is* the `--json` output. Prose is derived from it, never computed
  separately, so the two can never disagree.
- `registerFoo` sets `process.exitCode` from `report.ok`. Only `cli.ts` calls
  `process.exit` for a failure.
- Tests call `run*` directly. That is why they can assert on real behaviour
  without a subprocess.
- Help text carries **Examples**, and an **Agent usage** note wherever exit codes
  or the shape of the output need explaining. Agents read `--help`; treat it as
  documentation, not a formality.

## Conventions

**Comments explain why.** A comment earns its place by recording a constraint, a
trade-off, or a surprise that the code cannot show — why the process environment
beats `.env`, why a connection comment goes on the key and not the value. Never
narrate what the next line does, and never explain a change to a reviewer; that
becomes noise the moment the PR merges.

**User-facing prose is plain sentences.** Say what happened and what to do next.
Errors carry a `hint` with the concrete next command. No jargon the reader has not
been given, no cheerfulness.

**Tests use the real thing.** Malloy really compiles, DuckDB really runs, the
scaffold really writes to a temp directory. The database is not mocked: a compile
that passes must mean the columns exist, and a mock cannot promise that. Anything
needing credentials is `describe.skipIf`-gated on an environment variable and
committed, so a machine that has them proves the wiring rather than a person
checking by hand.

**Never scaffold into this repo.** `mora init .` in the working tree will write
over `AGENTS.md` and friends. Use a temp directory, always.

**Docs ship with the change.** A new flag or command is not done until the README
section, the `--help` text, and the relevant `src/templates/agent-docs.ts` guide
say so. The templates are how a user's agent learns what exists; leaving them
stale ships a CLI that lies about itself.

## Decisions worth not relitigating

Recorded so they are not rediscovered by accident:

- **`metrics/`, not `semantic/`, and not a prompt.** Standardisation is worth more
  than the choice.
- **DuckDB is always declared,** even for a warehouse project, so the example
  compiles and a project always has one connection that works.
- **Table paths resolve from the models directory,** not the data directory, so
  the same model works under Publisher and the VS Code extension.
- **Doc strings on pass-through queries are omitted.** A `query:` that runs a view
  inherits its description; repeating it produces a concatenated, redundant one.
- **BigQuery `project_id` also defaults the billing project.** The driver only
  uses `projectId` to qualify table names and bills against `billingProjectId`;
  setting one and getting "unable to detect a project id" is not acceptable.
- **A setting the driver ignores does not get a prompt.** `dataset` was removed
  for exactly this reason. Offering a knob that does nothing is a lie.
- **`init` join mode skips compiling when a credential is unset,** rather than
  failing every model with the message it just printed.
- **Publisher is a plugin, not part of the scaffold.** A project that will never
  be served should not carry two JSON files explaining how to serve it. The
  extension point is a plugin because "add a Publisher command" and "add a plugin
  system whose first plugin is Publisher" cost about the same, and only one of
  them means the next integration is not another flag on `init`.
- **`mora plugin`, singular, in the group grammar.** It matches
  `mora connection add`, and `mora add` would not say what is being added.
- **Plugins are recorded in `mora.yaml`,** not inferred from files on disk. A
  teammate cloning the repo can then be *told* which integrations the project
  uses and which are missing locally, instead of Mora guessing from a file that
  might have been deleted by hand.
- **A refused `remove` writes nothing at all.** Deleting some files and leaving
  others, or unrecording a plugin whose files are still there, is the half-success
  the principles rule out. Modified files are detected first, then the command
  either goes through or does not start.

## Where this goes next

In rough order, and each one should stay recognisable as the same tool:

1. **More warehouses.** DuckDB and BigQuery work. Snowflake, Postgres and Trino
   are drivers Malloy already has, and each is a connection type away — the
   registry in `databases.ts` plus a case in `runtime.ts`.
2. **Real retrieval in `describe`.** Today it is substring matching over names and
   doc strings. An agent should be able to find a definition by meaning, over the
   committed vocabulary first. Searching the *warehouse* schema is a separate,
   later problem; do not conflate them.
3. **MCP over the development loop.** `validate`, `describe` and `query` against a
   checkout, for agents that prefer tools to shell commands. Serving finished
   models over MCP is Publisher's job and stays there.
4. **More plugins.** The interface is one function on purpose. Grow it only when a
   real integration cannot be expressed as "these files, these gitignore lines,
   these next steps" — a plugin that wants to register a command or hook
   `validate` is a request to redesign this, not a flag to add.

`mora upgrade` is shipped: it refreshes `.agents/`, the managed `AGENTS.md`
block, and the `cli_version` stamp, with an empty migration list ready for the
first schema change. Future config shape changes belong in `src/migrate.ts`.
`plugins:` needed no migration because an absent key means no plugins.

## Before you call it done

```bash
npm run typecheck && npm run lint && npm test
npm run build && node dist/cli.js <the thing you changed>   # in a temp dir
```

The last line is not optional. Unit tests do not catch a broken `--help`, a
prompt that hangs without a TTY, or a report that reads badly, and those are the
parts a user meets first.

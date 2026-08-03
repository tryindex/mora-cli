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

Moving the definitions into a semantic layer is the fix, and it is also the part
nobody does. dbt has had a metrics layer for years and it is famously underused —
not because running reviewed metrics is hard, but because *writing* them is: it
means reading unfamiliar tables, checking what the columns actually mean, and
getting a human to agree the scope. That work is what Mora is for.

## What Mora is

Mora is a command line for one loop, and the loop is the product:

```
1. mora schema        what the warehouse holds
2. mora query -f      what is true of it, checked rather than assumed
3. ask a human        which of it is worth modelling
4. write the models   documented definitions, in metrics/
5. mora validate      they compile, so the columns really exist
6. pull request       a human approves them, which is what makes them trustworthy
```

Three consequences follow, and they are the whole design:

1. **A pull request is the trust mechanism.** A definition is trustworthy because
   a human approved it, not because the tool is clever. Everything Mora does
   should make a change to a definition easier to review, and every command
   should be judged by whether it moves the loop forward.
2. **Nothing is assumed about the data.** A column called `total` may or may not
   include tax, and the difference is a wrong number in a dashboard. Mora's job
   is to make checking cheaper than guessing — that is why `query` runs
   unreviewed Malloy at all, and why it says so in the report when it does.
3. **The interface is a CLI.** Any agent that can run a command can use Mora —
   Cursor, Claude Code, Codex, or something nobody has written yet. That is worth
   more than a nicer integration with any one of them.

## What Mora is not

Mora is the **authoring** half of a semantic layer. Deliberately out of scope:

- **Serving models.** [Malloy Publisher](https://github.com/malloydata/publisher)
  exposes models over REST and MCP to BI tools and applications. A Mora project
  works with it as-is, because table paths resolve from the models directory. We
  do not build a server and we do not write its config.
- **Being a BI tool.** No dashboards, no charts, no saved-report management.
  `mora query` prints rows so an answer can be checked, not so it can be
  presented.
- **A DSL of our own.** Models are Malloy. If Malloy needs a feature, the fix
  belongs upstream, not in a Mora abstraction that hides it.
- **Warehouse management.** Mora reads. It does not migrate schemas, load data,
  or schedule anything.
- **Wrapping things the agent can already do.** The agent is in the checkout. It
  can read `metrics/*.malloy` and it can read a README. A command that only
  reformats something already on disk is surface area with no user.

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
someone approved; `-e` and `-f` run logic nobody has. The result says which, and
the guidance tells agents to promote anything worth keeping into a named
definition. Never blur this to make output tidier.

**Definitions explain themselves.** `#"` doc strings are part of the model, not
comments on it, so they travel with a definition to anything that reads the model.
A definition arrives with the caveats that make it safe to use, or it invites
someone to re-derive it by hand. "Excludes the 3% of rows with a null region" is
the kind of thing that must not live only in the answer an agent gave once.

**What a metric means is not the agent's to decide.** An agent can establish from
the data whether `total` includes tax; it cannot establish whether a refunded
order counts as revenue, when the week starts, or which of three timestamps
finance reports on. Those are decisions, and a definition that makes them quietly
is exactly what the tool argues against. So the guidance gives a fixed set of
questions to work through before writing any metric, and the answers are recorded
where the next reader finds them: per-metric in the `#"` doc string, everything
that generalises in `metrics/conventions.md`.

**Committed files never hold secrets.** `mora.yaml` is committed, so credentials
go in as `${VAR}` and resolve only when a connection opens. `.env.example` records
which variables a project needs; `.env` holds values and is gitignored. When in
doubt, write the reference.

**Own little, and own it visibly.** `.agents/*.md` belongs to Mora and is
rewritten whenever Mora writes it. `AGENTS.md` is shared through
`mora:begin`/`mora:end` markers, with the team's section outside them.
`metrics/conventions.md` is the team's outright: written once and never again,
because everything in it is something they decided. `mora.yaml` belongs to the
project — which is why `mora connection add` edits it as a YAML document,
preserving comments, rather than re-rendering it.

**Convention over configuration.** Models go in `metrics/`, and `init` does not
ask. Every Mora project keeping them in the same place is worth more than the
choice, and it lets the docs an agent reads name the directory outright. Escape
hatches stay (`--models`), but they are not prompts.

**A scaffold is the semantic layer, and nothing else.** `init` writes the config,
an empty models directory, the docs, and `metrics/conventions.md` for the team to
answer. It does not write a model: what belongs there is sources over the
reader's own tables, and only they know which. It does not write anything a
project might not need.

**Five commands, and each one earns its place.** `init` and `connection` set a
project up; `schema`, `query` and `validate` are the loop. A sixth needs to be
something an agent cannot already do with the file system and these five.

## Architecture

```
src/cli.ts            registers commands, renders top-level failures
src/commands/*.ts     one file per command: flags, prompts, prose, JSON report
src/malloy/*.ts       the only code that imports Malloy
src/templates/*.ts    pure render functions, no I/O
src/*.ts              domain: config, connections, env, scaffold, version,
                      project, errors, databases
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
  `connections.ts`, environment resolution in `env.ts`. If a command starts
  reaching for `yaml`, the logic belongs one layer down.
- **`openProject` is the front door.** Commands that touch models load through it,
  so `validate` and `query` fail identically on the same problems.
  `mora schema` deliberately does not: it reads the database rather than the
  models, and requiring a populated `metrics/` would break it in the empty state
  it exists to serve. It loads the config and picks a connection instead.
- **One way to open one connection.** `withConnection` in `malloy/runtime.ts`
  resolves `${VAR}` references, opens, and closes. `connection test` and
  `schema` both go through it, so a credential that is unset fails with the same
  named-variable message either way.
- **The connection registry is one place.** `src/databases.ts` declares what each
  database needs; prompts, CLI flags and the YAML that gets written all derive
  from it, so they cannot drift.
- **`src/malloy/vocabulary.ts` is an index, not a command.** It reads sources,
  fields and named queries out of the compiled models, and its one consumer is
  `mora query` resolving a name. There is no command that prints it: see the
  decision below.

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

- **The modelling loop is the product; the commands are its parts.** Mora was
  briefly a broader tool — a vocabulary browser, a plugin system, an upgrade
  channel, a gcloud project picker. All of it was polish on an unvalidated
  premise, and it made the one differentiated thing harder to see. What is left
  is the path from a raw warehouse to a reviewed definition. Judge a proposed
  command by which step of that path it serves; if the answer is "none", it does
  not go in.
- **There is no `mora describe`.** There was, and it printed the vocabulary as a
  formatted listing. But the agent is in the checkout: reading `metrics/*.malloy`
  gives it the definitions with their doc strings, filters and joins, which is
  strictly more than the listing had, and substring matching over names was never
  retrieval. The index survives as `src/malloy/vocabulary.ts` because `query`
  needs it to resolve a name. Do not re-add the command; if finding definitions by
  meaning becomes a real problem, it is a retrieval problem, not a formatter.
- **No plugin system.** Publisher compatibility is a property of where table
  paths resolve from, not of files Mora writes. Two JSON files documented in the
  README cost a reader less than a plugin interface, a loader, a registry and a
  remove-that-refuses-atomically, none of which had a second plugin to justify
  them. A future integration that genuinely cannot be a doc can reopen this.
- **No `mora upgrade`, and no `cli_version` stamp.** Versioning the project
  separately from the binary buys the ability to migrate committed files, and
  there is nothing committed anywhere to migrate. Updating is `npm i -g
  @moradata/cli@latest`; re-scaffolding docs is `init --force`. When a config
  shape actually has to change under real users, migration comes back — with
  users to justify it.
- **`metrics/`, not `semantic/`, and not a prompt.** Standardisation is worth more
  than the choice.
- **Table paths resolve from the models directory,** not the data directory, so
  the same model works under Publisher and the VS Code extension.
- **`init` writes no model.** A generated example is a definition nobody
  reviewed, sitting in the one directory that is supposed to hold only reviewed
  definitions. The empty state is the honest one, and it is what sends an agent
  to `.agents/modeling.md`.
- **The metric questions are a doc, not a command.** A `mora ask` that printed a
  questionnaire would be the agent's own conversation routed through a
  subprocess, and it could not do the one thing that makes the questions cheap:
  drop the ones the repo already answers. The list lives in
  `.agents/modeling.md` because that is where the agent already looks before it
  models, and the answers land in the doc string and in
  `metrics/conventions.md`, both of which a reviewer reads anyway.
- **`metrics/conventions.md` is the one scaffolded file Mora never rewrites,**
  which is why `write-once` exists as a strategy alongside `replace` and
  `managed-block`. It cannot be Mora-owned: every line in it is a decision the
  team made, and refreshing it would delete exactly what it is for. It is not
  markers inside `AGENTS.md` either, because an agent adding a metric should
  read one short file about metrics rather than scan a document about the repo,
  and it belongs next to the models it qualifies so a diff to a definition and a
  diff to the rule behind it land in the same review. `--force` re-scaffolds
  Mora's output, not the team's, so it leaves this file alone too.
- **Doc strings on pass-through queries are omitted.** A `query:` that runs a view
  inherits its description; repeating it produces a concatenated, redundant one.
- **BigQuery `project_id` also defaults the billing project.** The driver only
  uses `projectId` to qualify table names and bills against `billingProjectId`;
  setting one and getting "unable to detect a project id" is not acceptable.
- **A setting the driver ignores does not get a prompt.** `dataset` was removed
  for exactly this reason. Offering a knob that does nothing is a lie.
- **Interactive BigQuery setup asks for a project id; it does not go looking.**
  Reading gcloud state to offer a searchable, data-filtered project list was a
  few hundred lines and a dependency to save typing a string a reader knows.
  Unattended runs always passed `--project-id` anyway, so none of it was on the
  path an agent takes.
- **`mora schema` reads the catalog live; nothing is cached to disk.** A snapshot
  is a second source of truth whose one distinguishing property is outliving the
  warehouse it describes, and an agent proposing joins from a stale dump is
  exactly the quiet wrongness Mora exists to prevent. The caller that would
  re-read a cache keeps the listing in its own context for as long as it is
  working, and the listing is a directory walk or one `INFORMATION_SCHEMA` query.
- **Knowing how to model is a doc, not a command.** `.agents/modeling.md` is
  owned like the other guides. Mora provides the facts — `schema` for what
  exists, `query -f` for what is true of it — and the judgement about which
  measures a team wants belongs to the agent and the human reviewing the PR. A
  `mora generate-model` that wrote sources on its own would be producing exactly
  the unreviewed definitions the tool argues against.
- **The BigQuery listing degrades to the datasets you can see.** Region-wide
  `INFORMATION_SCHEMA.TABLES` is one query and the whole answer, but it needs
  `bigquery.tables.list` across *every* dataset in the project — which an analyst
  granted three datasets does not have, and BigQuery then returns nothing rather
  than the three. So a permission denial falls back to project-level `SCHEMATA`
  (only `bigquery.datasets.get`, and it returns exactly what is visible) and one
  `UNION ALL` over those datasets. Two queries, not one per dataset, because an
  INFORMATION_SCHEMA query is billed a minimum either way. Verified against a real
  project: the region query is denied where the per-dataset query succeeds.
- **A table Malloy cannot read is a per-table failure, not a per-command one.**
  `schema` names the table that failed and still reports the others, because a
  batch that dies whole says nothing about which name was wrong. An empty column
  list therefore never means "no columns": that case carries an `error` and turns
  `ok` false.
- **Unreviewed Malloy is a document, not just a query.** An expression may
  declare its own source, which is what makes checking the data possible *before*
  any model exists — the first step of modelling, not an afterthought. `-f` and
  `-e -` exist because a real probe runs to several lines and shell quoting is the
  worst place to keep one. All of it is still `reviewed: false`.
- **A named view runs as `source -> view`, not through `loadExploreByName`.**
  That materializer compiles the view against the source in isolation and loses
  its joins: the SQL selects the joined column and never joins the table, so the
  database rejects a view that `validate` passed. Do not "simplify" it back —
  `test/query.test.ts` has a joined view guarding this, and the failure it
  catches looks like a broken model rather than a broken query path.
- **One `run:` per document, refused rather than executed in part.** Malloy
  materializes only a document's last query, so a probe stacking several checks
  answered one question while looking like it answered all of them — an agent
  batching five reads five answers off a result that held one. Running them all
  was the alternative, and it would have put a `results` array in the report and
  made top-level `rows` and `sql` mean whichever one you were not asking about;
  the ambiguity is what caused the bug. Counting is a scan for the `run:` token
  outside comments and strings, *not* `Parse.symbols`: that walker returns nothing
  at all for a query containing a `nest:`, which would refuse a good probe. A
  document with no `run:` is refused too, because Malloy reports that as
  "Internal compiler error ... Model has no queries" and asks the reader to file a
  bug against Malloy for a missing keyword.
- **An empty listing explains itself; the working directory default stays put.**
  `mora schema` used to answer an empty DuckDB listing with "check
  `mora connection test`", which passes for any DuckDB connection whether or not
  it can see data — a check that cannot fail is worse than no advice. So the
  report carries `readsFrom` and `dataElsewhere`, naming the directory it walked
  and the directories that do hold data, and the fix is a `working_directory`
  edit. Pointing `init` at the data instead would contradict table paths
  resolving from the models directory, and that portability is worth more than
  saving one edit. The project is only walked when the listing is empty and
  unfiltered, so a listing that found something pays nothing.

## Where this goes next

In rough order, and each one should stay recognisable as the same tool:

1. **Depth in the loop.** The unsolved problem is not running queries, it is
   getting from a strange warehouse to definitions a human will approve without
   wincing. Anything that makes the checks in `.agents/modeling.md` more
   thorough, or the evidence in the resulting pull request more convincing,
   is the highest-value work available.
2. **More warehouses.** DuckDB and BigQuery work. Snowflake, Postgres and Trino
   are drivers Malloy already has, and each is a connection type away — the
   registry in `databases.ts` plus a case in `runtime.ts`.
3. **MCP over the loop.** `schema`, `query` and `validate` against a checkout,
   for agents that prefer tools to shell commands. Serving finished models over
   MCP is Publisher's job and stays there.
4. **A second backend, once the loop is proven.** The discipline in
   `.agents/modeling.md` is not Malloy-specific: probe the assumptions, document
   the caveats, agree the scope, open a PR. If it demonstrably produces models
   humans accept, the same loop over dbt's semantic layer is where the users are.
   Do not start this before the loop has convinced anyone, and do not carry a
   backend abstraction in anticipation of it.

## Before you call it done

```bash
npm run typecheck && npm run lint && npm test
npm run build && node dist/cli.js <the thing you changed>   # in a temp dir
```

The last line is not optional. Unit tests do not catch a broken `--help`, a
prompt that hangs without a TTY, or a report that reads badly, and those are the
parts a user meets first.

export interface ConventionsDocOptions {
  modelsDir: string;
  /** Where Mora keeps the docs it owns, e.g. `.agents`. */
  agentDocsDir: string;
}

/**
 * The one scaffolded file a team owns outright. It holds the answers that hold
 * for every metric, so the question flow in `.agents/modeling.md` can skip them
 * instead of asking again. Written once and never rewritten: an existing copy
 * is the team's own work, and refreshing it would throw away exactly what makes
 * it worth having.
 */
export function renderConventionsDoc({ modelsDir, agentDocsDir }: ConventionsDocOptions): string {
  return `# Metric conventions

This file is yours. Mora writes it once and never touches it again, so anything
recorded here survives every later \`mora init\`.

It holds the answers that are true of every metric in \`${modelsDir}/\`, so nobody
has to be asked them twice. Before adding a definition, an agent reads this file
and the models next to it, then asks only about what is still open — that is what
\`${agentDocsDir}/modeling.md\` tells it to do. Every answer written down here is
a question that never gets asked again.

Sections still holding the prompt they were scaffolded with are unanswered, and
an agent will ask about them. That is the honest state: fill one in when the
team has actually agreed, not before.

## Canonical sources

_Which tables are the source of truth for which subject, and which ones look
authoritative but are not — staging, exports, pre-aggregated snapshots, anything
a pipeline rebuilds._

## Naming

_How measures and dimensions are named here, and any prefix or suffix that
carries meaning: a \`_gross\` measure that includes tax, a \`_d7\` window._

## Time

_Which timestamp column is canonical for reporting, when a week starts, whether
the fiscal year differs from the calendar year, and which timezone a day is
measured in._

## Standard filters

_Rows excluded from every metric unless a definition says otherwise: test
accounts, internal orders, cancelled rows._

## Reconciliation

_The numbers a new metric has to agree with before anyone trusts it, and where
those numbers come from._

## Ownership and review

_Who owns these definitions, who approves a change to one, and anything that
needs a wider sign-off than a normal pull request._

## Questions to ask before adding a metric

_Anything this team wants asked on top of the standard list in
\`${agentDocsDir}/modeling.md\`._
`;
}

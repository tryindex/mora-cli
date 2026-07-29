export interface ExampleModelOptions {
  /** Name of the connection declared in mora.yaml that this model reads from. */
  connectionName: string;
  /** Path to the sample CSV, relative to the connection's working directory. */
  tablePath: string;
}

export function renderExampleModel({ connectionName, tablePath }: ExampleModelOptions): string {
  return `// ---------------------------------------------------------------------------
// Example semantic model
//
// A semantic model is a vocabulary: named dimensions and measures that an
// agent can combine into queries. Because the definitions live here, every
// query agrees on what "revenue" means, and the agent never has to guess.
//
// Replace this file with sources over your own tables.
// ---------------------------------------------------------------------------

source: orders is ${connectionName}.table('${tablePath}') extend {
  primary_key: id

  // Dimensions are the attributes you can group by and filter on.
  dimension:
    ordered_at is order_date::date
    ordered_month is ordered_at.month
    is_large_order is amount > 500

  // Measures are aggregations. Defining them once here is what makes a query
  // trustworthy: nobody re-derives "revenue" with a slightly different filter.
  measure:
    order_count is count()
    customer_count is count(customer_name)
    revenue is amount.sum()
    average_order_value is amount.avg()

  // Views are reusable, named query shapes. Prefer adding a view over writing
  // a one-off query, so the next question reuses vetted logic.
  view: revenue_by_month is {
    group_by: ordered_month
    aggregate: revenue, order_count
    order_by: ordered_month
  }

  view: revenue_by_region is {
    group_by: region
    aggregate: revenue, order_count, average_order_value
    order_by: revenue desc
  }

  view: top_customers is {
    group_by: customer_name
    aggregate: revenue, order_count
    order_by: revenue desc
    limit: 10
  }
}

// Named queries are the entry points an agent should reach for first.
query: monthly_revenue is orders -> revenue_by_month

query: regional_performance is orders -> revenue_by_region

query: completed_revenue_by_month is orders -> {
  where: status = 'completed'
  group_by: ordered_month
  aggregate: revenue, order_count
  order_by: ordered_month
}
`;
}

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
// Lines starting with #" are doc strings. They are part of the model, not
// comments: \`mora describe\` shows them, and a served model exposes them to
// whoever is asking. Write them for the reader who has to trust the number.
//
// Replace this file with sources over your own tables.
// ---------------------------------------------------------------------------

#" One row per order, with the customer and region that placed it.
source: orders is ${connectionName}.table('${tablePath}') extend {
  primary_key: id

  // Dimensions are the attributes you can group by and filter on.
  dimension:
    #" Date the order was placed.
    ordered_at is order_date::date
    #" Month the order was placed, for trends over time.
    ordered_month is ordered_at.month
    #" An order over $500. The threshold is a business convention, not a fact.
    is_large_order is amount > 500

  // Measures are aggregations. Defining them once here is what makes a query
  // trustworthy: nobody re-derives "revenue" with a slightly different filter.
  measure:
    #" Number of orders.
    order_count is count()
    #" Distinct customers who placed an order.
    customer_count is count(customer_name)
    #" Total order amount, including orders that are not yet completed.
    revenue is amount.sum()
    #" Mean order amount. Skewed by large orders, so read it next to revenue.
    average_order_value is amount.avg()

  // Views are reusable, named query shapes. Prefer adding a view over writing
  // a one-off query, so the next question reuses vetted logic.
  #" Revenue and order count for each month.
  view: revenue_by_month is {
    group_by: ordered_month
    aggregate: revenue, order_count
    order_by: ordered_month
  }

  #" How each region is performing, best revenue first.
  view: revenue_by_region is {
    group_by: region
    aggregate: revenue, order_count, average_order_value
    order_by: revenue desc
  }

  #" The ten customers with the most revenue.
  view: top_customers is {
    group_by: customer_name
    aggregate: revenue, order_count
    order_by: revenue desc
    limit: 10
  }
}

// Named queries are the entry points an agent should reach for first. A query
// that just runs a view inherits the view's description, so there is nothing to
// restate here.
query: monthly_revenue is orders -> revenue_by_month

query: regional_performance is orders -> revenue_by_region

#" Monthly revenue counting only completed orders. Use this when the question
#" is about money actually earned rather than orders placed.
query: completed_revenue_by_month is orders -> {
  where: status = 'completed'
  group_by: ordered_month
  aggregate: revenue, order_count
  order_by: ordered_month
}
`;
}

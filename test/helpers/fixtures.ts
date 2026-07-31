import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A model and the data behind it, for tests that need a semantic layer to read.
 *
 * The CLI ships neither: `mora init` writes an empty models directory, because
 * what belongs in it is sources over the reader's own tables. Tests still need
 * something real to compile and query — DuckDB is not mocked here — so the
 * orders dataset lives on as a fixture rather than as a scaffolded file.
 */
export const ORDERS_CSV = `id,order_date,customer_name,region,product,quantity,amount,status
1,2024-01-04,Acme Corp,North America,Starter Plan,1,240.00,completed
2,2024-01-11,Blue Ridge Foods,North America,Growth Plan,2,980.00,completed
3,2024-01-18,Cedar Analytics,Europe,Starter Plan,1,240.00,completed
4,2024-01-25,Dunn Logistics,North America,Enterprise Plan,1,3200.00,completed
5,2024-02-02,Everline Media,Europe,Growth Plan,1,490.00,completed
6,2024-02-07,Acme Corp,North America,Growth Plan,3,1470.00,completed
7,2024-02-14,Foxglove Labs,Asia Pacific,Starter Plan,2,480.00,refunded
8,2024-02-19,Blue Ridge Foods,North America,Starter Plan,1,240.00,completed
9,2024-02-26,Granite Retail,Europe,Enterprise Plan,1,3200.00,completed
10,2024-03-01,Harbor Health,North America,Growth Plan,1,490.00,completed
11,2024-03-06,Cedar Analytics,Europe,Growth Plan,2,980.00,completed
12,2024-03-12,Ivy Systems,Asia Pacific,Starter Plan,1,240.00,pending
13,2024-03-15,Dunn Logistics,North America,Growth Plan,1,490.00,completed
14,2024-03-21,Juniper Travel,Europe,Starter Plan,4,960.00,completed
15,2024-03-28,Acme Corp,North America,Enterprise Plan,1,3200.00,completed
16,2024-04-02,Kestrel Energy,Asia Pacific,Growth Plan,1,490.00,completed
17,2024-04-09,Everline Media,Europe,Starter Plan,1,240.00,refunded
18,2024-04-15,Harbor Health,North America,Enterprise Plan,2,6400.00,completed
19,2024-04-22,Foxglove Labs,Asia Pacific,Growth Plan,1,490.00,completed
20,2024-04-29,Granite Retail,Europe,Growth Plan,2,980.00,pending
21,2024-05-03,Ivy Systems,Asia Pacific,Enterprise Plan,1,3200.00,completed
22,2024-05-10,Juniper Travel,Europe,Growth Plan,1,490.00,completed
23,2024-05-17,Blue Ridge Foods,North America,Enterprise Plan,1,3200.00,completed
24,2024-05-24,Kestrel Energy,Asia Pacific,Starter Plan,3,720.00,completed
25,2024-05-31,Cedar Analytics,Europe,Starter Plan,1,240.00,completed
`;

export const ORDERS_MODEL_FILENAME = 'orders.malloy';
export const DATA_DIR = 'data';
export const ORDERS_CSV_FILENAME = 'orders.csv';
/** How the model names the CSV: relative to the connection's working directory. */
export const ORDERS_TABLE_PATH = `${DATA_DIR}/${ORDERS_CSV_FILENAME}`;

export interface OrdersModelOptions {
  connectionName?: string;
  /** Path the source reads, when it is not the fixture CSV. */
  tablePath?: string;
}

export function renderOrdersModel({
  connectionName = 'duckdb',
  tablePath = ORDERS_TABLE_PATH,
}: OrdersModelOptions = {}): string {
  return `#" One row per order, with the customer and region that placed it.
source: orders is ${connectionName}.table('${tablePath}') extend {
  primary_key: id

  dimension:
    #" Date the order was placed.
    ordered_at is order_date::date
    #" Month the order was placed, for trends over time.
    ordered_month is ordered_at.month
    #" An order over $500. The threshold is a business convention, not a fact.
    is_large_order is amount > 500

  measure:
    #" Number of orders.
    order_count is count()
    #" Distinct customers who placed an order.
    customer_count is count(customer_name)
    #" Total order amount, including orders that are not yet completed.
    revenue is amount.sum()
    #" Mean order amount. Skewed by large orders, so read it next to revenue.
    average_order_value is amount.avg()

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

export interface WrittenOrdersModel {
  /** Model path relative to the project root. */
  modelPath: string;
  /** CSV path relative to the project root. */
  dataPath: string;
}

/**
 * Writes the orders model and its CSV into a scaffolded project, the way a
 * reader would after running `mora schema`.
 */
export async function writeOrdersModel(
  root: string,
  options: OrdersModelOptions & { modelsDir?: string; withData?: boolean } = {},
): Promise<WrittenOrdersModel> {
  const { modelsDir = 'metrics', withData = true, ...model } = options;
  const modelPath = `${modelsDir}/${ORDERS_MODEL_FILENAME}`;
  const dataPath = `${modelsDir}/${ORDERS_TABLE_PATH}`;

  await mkdir(path.join(root, modelsDir), { recursive: true });
  await writeFile(path.join(root, modelPath), renderOrdersModel(model), 'utf8');

  if (withData) {
    await mkdir(path.dirname(path.join(root, dataPath)), { recursive: true });
    await writeFile(path.join(root, dataPath), ORDERS_CSV, 'utf8');
  }

  return { modelPath, dataPath };
}

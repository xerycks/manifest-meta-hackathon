import type { Pool } from "pg"

/** The only schemas the demo builder drops and recreates. */
export const DEMO_SOURCE_SCHEMAS = ["shop", "support"] as const

export interface DemoSourceSummary {
  customers: number
  products: number
  orders: number
  orderItems: number
  agents: number
  tickets: number
}

// Values come from md5-based pseudo-randomness keyed by row, so every run
// produces the same rows; timestamps are placed relative to the run date so
// "last month" questions always have data. Covers ~18 months of orders.
const BUILD_SQL = String.raw`
DROP SCHEMA IF EXISTS support CASCADE;
DROP SCHEMA IF EXISTS shop CASCADE;
CREATE SCHEMA shop;
CREATE SCHEMA support;
COMMENT ON SCHEMA shop IS 'Online coffee and tea store: customers, catalog, orders (synthetic demo data).';
COMMENT ON SCHEMA support IS 'Customer support desk for the store (synthetic demo data).';

-- Deterministic uniform value in [0, 1) for a text key.
CREATE OR REPLACE FUNCTION pg_temp.rnd(key text) RETURNS double precision
  LANGUAGE sql IMMUTABLE
  AS $fn$ SELECT ('x' || substr(md5(key), 1, 8))::bit(32)::bigint / 4294967296.0 $fn$;

CREATE TEMP TABLE demo_window ON COMMIT DROP AS
SELECT (current_date - 540)::timestamptz AS starts_at,
       now() AS ends_at,
       extract(year FROM current_date - interval '1 year')::int AS holiday_year;

-- Customers -----------------------------------------------------------------

CREATE TABLE shop.customers (
  id integer PRIMARY KEY,
  full_name text NOT NULL,
  email text NOT NULL UNIQUE,
  country text NOT NULL,
  segment text NOT NULL CHECK (segment IN ('consumer', 'small_business', 'enterprise')),
  marketing_opt_in boolean NOT NULL,
  signed_up_at timestamptz NOT NULL
);
COMMENT ON TABLE shop.customers IS 'People and companies that have an account with the store.';
COMMENT ON COLUMN shop.customers.segment IS 'consumer, small_business (offices, cafes), or enterprise (corporate accounts).';

INSERT INTO shop.customers
SELECT c.i,
       c.first_name || ' ' || c.last_name,
       lower(c.first_name || '.' || c.last_name) || c.i || '@example.com',
       c.countries[1 + floor(pg_temp.rnd('country:' || c.i) * cardinality(c.countries))::int],
       CASE
         WHEN pg_temp.rnd('segment:' || c.i) < 0.80 THEN 'consumer'
         WHEN pg_temp.rnd('segment:' || c.i) < 0.95 THEN 'small_business'
         ELSE 'enterprise'
       END,
       pg_temp.rnd('opt-in:' || c.i) < 0.6,
       -- Strictly increasing with id: sign-ups start 120 days before the order window.
       w.starts_at - interval '120 days'
         + (c.i - 1) * (interval '646 days' / 800)
         + pg_temp.rnd('signup:' || c.i) * interval '18 hours'
FROM (
  SELECT i,
         (ARRAY['Ava','Liam','Maya','Noah','Zara','Ethan','Priya','Lucas','Chloe','Mateo',
                'Hana','Oliver','Amara','Leo','Sofia','Kai','Ines','Arjun','Freya','Diego',
                'Nora','Felix','Aisha','Hugo','Mila','Omar','Elena','Ravi','Lena','Tomas',
                'Yuki','Isaac','Clara','Jonas','Leila','Marco','Anika','Sam','Iris','Theo'])[1 + (i * 7) % 40] AS first_name,
         (ARRAY['Patel','Garcia','Kim','Nguyen','Smith','Muller','Rossi','Silva','Okafor','Johansson',
                'Chen','Kowalski','Dubois','Haddad','Tanaka','Murphy','Novak','Costa','Ibrahim','Larsen',
                'Schmidt','Moreau','Singh','Lopez','Bauer','Fischer','Wright','Ali','Romero','Sato',
                'Eriksen','Martin','Hughes','Mendes','Yilmaz','Walsh','Petrov','Reyes','Olsen','Shah'])[1 + (i * 13) % 40] AS last_name,
         ARRAY['US','US','US','US','US','US','US','GB','GB','GB',
               'CA','CA','DE','DE','AU','AU','FR','NL','IN','SE'] AS countries
  FROM generate_series(1, 800) AS i
) AS c
CROSS JOIN demo_window AS w;

-- Products ------------------------------------------------------------------

CREATE TABLE shop.products (
  id integer PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL,
  unit_price numeric(10, 2) NOT NULL CHECK (unit_price > 0),
  unit_cost numeric(10, 2) NOT NULL CHECK (unit_cost > 0),
  is_active boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE shop.products IS 'Catalog of items the store sells.';
COMMENT ON COLUMN shop.products.unit_price IS 'Current list price in USD.';
COMMENT ON COLUMN shop.products.unit_cost IS 'What the store pays per unit in USD; price minus cost is gross margin.';

INSERT INTO shop.products (id, sku, name, category, unit_price, unit_cost, is_active) VALUES
  (1, 'BEAN-ETH-250', 'Ethiopia Yirgacheffe 250g', 'Coffee beans', 16.50, 7.10, true),
  (2, 'BEAN-COL-250', 'Colombia Huila 250g', 'Coffee beans', 14.00, 5.90, true),
  (3, 'BEAN-HOU-1K', 'House Espresso Blend 1kg', 'Coffee beans', 38.00, 16.40, true),
  (4, 'BEAN-KEN-250', 'Kenya Nyeri AA 250g', 'Coffee beans', 18.50, 8.20, true),
  (5, 'BEAN-DEC-250', 'Swiss Water Decaf 250g', 'Coffee beans', 15.00, 6.50, true),
  (6, 'BEAN-GUA-250', 'Guatemala Antigua 250g', 'Coffee beans', 15.50, 6.60, true),
  (7, 'BEAN-SUM-1K', 'Sumatra Mandheling 1kg', 'Coffee beans', 41.00, 18.00, true),
  (8, 'BEAN-BRA-250', 'Brazil Cerrado 250g', 'Coffee beans', 12.50, 5.10, true),
  (9, 'TEA-SEN-100', 'Japanese Sencha 100g', 'Tea', 13.00, 4.80, true),
  (10, 'TEA-ASS-200', 'Assam Breakfast 200g', 'Tea', 11.00, 3.90, true),
  (11, 'TEA-EGR-100', 'Earl Grey Lavender 100g', 'Tea', 12.00, 4.20, true),
  (12, 'TEA-MAT-050', 'Ceremonial Matcha 50g', 'Tea', 24.00, 11.50, true),
  (13, 'TEA-CHA-200', 'Masala Chai 200g', 'Tea', 10.50, 3.70, true),
  (14, 'TEA-ROO-100', 'Rooibos Vanilla 100g', 'Tea', 9.50, 3.20, true),
  (15, 'EQP-PRS-08', 'French Press 8 cup', 'Brewing equipment', 34.00, 14.00, true),
  (16, 'EQP-V60-02', 'Pour-over Dripper', 'Brewing equipment', 26.00, 9.50, true),
  (17, 'EQP-GRD-PRO', 'Precision Burr Grinder', 'Brewing equipment', 189.00, 96.00, true),
  (18, 'EQP-KET-GN', 'Gooseneck Kettle', 'Brewing equipment', 72.00, 31.00, true),
  (19, 'EQP-AER-01', 'Travel Press', 'Brewing equipment', 39.00, 15.50, true),
  (20, 'EQP-ESP-HM', 'Home Espresso Machine', 'Brewing equipment', 449.00, 260.00, true),
  (21, 'ACC-FLT-100', 'Paper Filters (100)', 'Accessories', 6.50, 1.80, true),
  (22, 'ACC-SCL-01', 'Brewing Scale', 'Accessories', 42.00, 17.00, true),
  (23, 'ACC-MUG-CE', 'Ceramic Mug', 'Accessories', 16.00, 5.50, true),
  (24, 'ACC-TUM-SS', 'Insulated Tumbler', 'Accessories', 28.00, 10.00, true),
  (25, 'ACC-CAN-01', 'Airtight Bean Canister', 'Accessories', 22.00, 8.00, true),
  (26, 'ACC-TMP-58', 'Espresso Tamper 58mm', 'Accessories', 35.00, 12.50, false),
  (27, 'SUB-MON-01', 'Monthly Coffee Subscription', 'Subscriptions', 29.00, 13.00, true),
  (28, 'SUB-TEA-01', 'Monthly Tea Subscription', 'Subscriptions', 24.00, 10.00, true),
  (29, 'SUB-OFF-01', 'Office Coffee Plan', 'Subscriptions', 149.00, 72.00, true),
  (30, 'GFT-SMP-01', 'Origins Sampler Gift Box', 'Gift sets', 45.00, 19.00, true),
  (31, 'GFT-TEA-01', 'Tea Lover Gift Set', 'Gift sets', 39.00, 16.00, true);

-- Orders --------------------------------------------------------------------

CREATE TABLE shop.orders (
  id integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES shop.customers (id),
  ordered_at timestamptz NOT NULL,
  channel text NOT NULL CHECK (channel IN ('web', 'mobile_app', 'marketplace')),
  status text NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded')),
  subtotal numeric(12, 2) NOT NULL DEFAULT 0,
  discount numeric(12, 2) NOT NULL DEFAULT 0,
  shipping_fee numeric(12, 2) NOT NULL DEFAULT 0,
  total numeric(12, 2) NOT NULL DEFAULT 0,
  refunded_at timestamptz,
  CHECK (total = subtotal - discount + shipping_fee),
  CHECK ((status = 'refunded') = (refunded_at IS NOT NULL))
);
COMMENT ON TABLE shop.orders IS 'One row per checkout. Amounts are in USD.';
COMMENT ON COLUMN shop.orders.status IS 'pending -> paid -> shipped -> delivered; cancelled orders were never fulfilled; refunded orders were paid and later refunded in full.';
COMMENT ON COLUMN shop.orders.total IS 'Amount charged: subtotal - discount + shipping_fee. Exclude cancelled and refunded orders when reporting revenue.';
COMMENT ON COLUMN shop.orders.channel IS 'Where the order was placed: web, mobile_app, or marketplace (third-party storefront).';

INSERT INTO shop.orders (id, customer_id, ordered_at, channel, status, refunded_at)
SELECT o.id,
       1 + floor(power(pg_temp.rnd('customer:' || o.id), 1.6) * eligible.k)::int,
       o.ordered_at,
       o.channel,
       s.status,
       CASE
         WHEN s.status = 'refunded'
           THEN least(o.ordered_at + (3 + pg_temp.rnd('refund:' || o.id) * 18) * interval '1 day', w.ends_at)
       END
FROM (
  SELECT d.id,
         d.ordered_at,
         CASE
           WHEN pg_temp.rnd('channel:' || d.id) < 0.55 THEN 'web'
           WHEN pg_temp.rnd('channel:' || d.id) < 0.85 THEN 'mobile_app'
           ELSE 'marketplace'
         END AS channel
  FROM (
    -- Steady growth: later months get more orders.
    SELECT i AS id,
           w.starts_at + power(pg_temp.rnd('day:' || i), 0.75) * (w.ends_at - w.starts_at) AS ordered_at
    FROM generate_series(1, 3600) AS i CROSS JOIN demo_window AS w
    UNION ALL
    -- Holiday rush: 15 Nov - 31 Dec of the last complete season.
    SELECT i,
           make_date(w.holiday_year, 11, 15)::timestamptz
             + floor(pg_temp.rnd('day:' || i) * 47) * interval '1 day'
             + pg_temp.rnd('time:' || i) * interval '24 hours'
    FROM generate_series(3601, 4000) AS i CROSS JOIN demo_window AS w
  ) AS d
) AS o
CROSS JOIN demo_window AS w
-- Only customers who had signed up by then can order; earlier customers order more often.
CROSS JOIN LATERAL (
  SELECT count(*) AS k FROM shop.customers AS c WHERE c.signed_up_at <= o.ordered_at
) AS eligible
CROSS JOIN LATERAL (
  SELECT CASE
           WHEN pg_temp.rnd('status:' || o.id) < 0.04 THEN 'cancelled'
           WHEN w.ends_at - o.ordered_at >= interval '5 days'
                AND pg_temp.rnd('status:' || o.id)
                    < 0.04 + CASE o.channel WHEN 'marketplace' THEN 0.11 WHEN 'mobile_app' THEN 0.05 ELSE 0.04 END
             THEN 'refunded'
           WHEN w.ends_at - o.ordered_at < interval '6 hours' THEN 'pending'
           WHEN w.ends_at - o.ordered_at < interval '2 days' THEN 'paid'
           WHEN w.ends_at - o.ordered_at < interval '7 days' THEN 'shipped'
           ELSE 'delivered'
         END AS status
) AS s;

CREATE TABLE shop.order_items (
  id integer PRIMARY KEY,
  order_id integer NOT NULL REFERENCES shop.orders (id),
  product_id integer NOT NULL REFERENCES shop.products (id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(10, 2) NOT NULL,
  line_total numeric(12, 2) NOT NULL,
  UNIQUE (order_id, product_id)
);
COMMENT ON TABLE shop.order_items IS 'Products in each order. unit_price is the price paid at checkout.';

INSERT INTO shop.order_items (id, order_id, product_id, quantity, unit_price, line_total)
SELECT row_number() OVER (ORDER BY l.order_id, l.product_id),
       l.order_id, l.product_id, l.quantity, p.unit_price, l.quantity * p.unit_price
FROM (
  SELECT DISTINCT ON (o.id, line.product_id)
         o.id AS order_id, line.product_id, line.quantity
  FROM shop.orders AS o
  JOIN shop.customers AS c ON c.id = o.customer_id
  CROSS JOIN LATERAL generate_series(1, 1 + floor(power(pg_temp.rnd('lines:' || o.id), 1.5) * 4)::int) AS n
  CROSS JOIN LATERAL (
    -- Lower ids (coffee beans) sell most often; business accounts buy in bulk.
    SELECT 1 + floor(power(pg_temp.rnd('product:' || o.id || ':' || n), 1.4) * 31)::int AS product_id,
           (1 + floor(power(pg_temp.rnd('quantity:' || o.id || ':' || n), 2) * 3)::int)
             * CASE c.segment WHEN 'enterprise' THEN 5 WHEN 'small_business' THEN 2 ELSE 1 END AS quantity
  ) AS line
  ORDER BY o.id, line.product_id, n
) AS l
JOIN shop.products AS p ON p.id = l.product_id;

UPDATE shop.orders AS o
SET subtotal = t.subtotal,
    discount = t.discount,
    shipping_fee = t.shipping_fee,
    total = t.subtotal - t.discount + t.shipping_fee
FROM (
  SELECT s.order_id,
         s.subtotal,
         CASE WHEN pg_temp.rnd('discount:' || s.order_id) < 0.18 THEN round(s.subtotal * 0.10, 2) ELSE 0 END AS discount,
         CASE WHEN s.subtotal >= 60 THEN 0 ELSE 5.95 END AS shipping_fee
  FROM (SELECT order_id, sum(line_total) AS subtotal FROM shop.order_items GROUP BY order_id) AS s
) AS t
WHERE t.order_id = o.id;

-- A stale batch of House Espresso Blend about five months ago drove a spike in refunds.
UPDATE shop.orders AS o
SET status = 'refunded',
    refunded_at = o.ordered_at + (4 + pg_temp.rnd('stale-batch:' || o.id) * 10) * interval '1 day'
FROM demo_window AS w
WHERE o.status = 'delivered'
  AND o.ordered_at >= w.ends_at - interval '185 days'
  AND o.ordered_at < w.ends_at - interval '140 days'
  AND EXISTS (SELECT 1 FROM shop.order_items AS i WHERE i.order_id = o.id AND i.product_id = 3)
  AND pg_temp.rnd('stale-batch-refund:' || o.id) < 0.6;

CREATE INDEX orders_customer_idx ON shop.orders (customer_id);
CREATE INDEX orders_ordered_at_idx ON shop.orders (ordered_at);
CREATE INDEX order_items_order_idx ON shop.order_items (order_id);
CREATE INDEX order_items_product_idx ON shop.order_items (product_id);

-- Support -------------------------------------------------------------------

CREATE TABLE support.agents (
  id integer PRIMARY KEY,
  full_name text NOT NULL,
  team text NOT NULL CHECK (team IN ('Tier 1', 'Tier 2')),
  hired_on date NOT NULL
);
COMMENT ON TABLE support.agents IS 'Support staff. Tier 2 handles escalated and high-priority tickets.';

INSERT INTO support.agents (id, full_name, team, hired_on)
SELECT a.id, a.full_name, a.team, current_date - a.tenure_days
FROM (VALUES
  (1, 'Rosa Alvarez', 'Tier 1', 900),
  (2, 'Ben Carter', 'Tier 1', 720),
  (3, 'Mei Lin', 'Tier 1', 610),
  (4, 'Jamal Wright', 'Tier 1', 400),
  (5, 'Sara Novak', 'Tier 1', 200),
  (6, 'Victor Hale', 'Tier 2', 1100),
  (7, 'Grace Okoro', 'Tier 2', 850),
  (8, 'Daniel Sousa', 'Tier 2', 500)
) AS a (id, full_name, team, tenure_days);

CREATE TABLE support.tickets (
  id integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES shop.customers (id),
  order_id integer REFERENCES shop.orders (id),
  agent_id integer REFERENCES support.agents (id),
  category text NOT NULL CHECK (category IN ('shipping', 'billing', 'product_issue', 'account', 'other')),
  priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  subject text NOT NULL,
  created_at timestamptz NOT NULL,
  first_response_at timestamptz,
  resolved_at timestamptz,
  satisfaction_score smallint CHECK (satisfaction_score BETWEEN 1 AND 5),
  CHECK (first_response_at IS NULL OR first_response_at >= created_at),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);
COMMENT ON TABLE support.tickets IS 'Customer support requests, optionally about a specific order.';
COMMENT ON COLUMN support.tickets.status IS 'open (awaiting first response), pending (in progress), resolved (fixed in the last few days), closed (done).';
COMMENT ON COLUMN support.tickets.resolved_at IS 'When the issue was fixed; resolution time is resolved_at - created_at. Null while open or pending.';
COMMENT ON COLUMN support.tickets.satisfaction_score IS 'Optional 1-5 rating the customer gave after resolution.';

CREATE TEMP TABLE ticket_seed ON COMMIT DROP AS
SELECT 'order:' || o.id AS key,
       o.customer_id,
       o.id AS order_id,
       o.ordered_at + (1 + pg_temp.rnd('ticket-day:' || o.id) * 9) * interval '1 day' AS created_at,
       CASE
         WHEN o.status = 'refunded'
           THEN CASE WHEN pg_temp.rnd('ticket-cat:' || o.id) < 0.6 THEN 'product_issue' ELSE 'billing' END
         WHEN o.status = 'cancelled'
           THEN CASE WHEN pg_temp.rnd('ticket-cat:' || o.id) < 0.7 THEN 'billing' ELSE 'shipping' END
         WHEN pg_temp.rnd('ticket-cat:' || o.id) < 0.55 THEN 'shipping'
         WHEN pg_temp.rnd('ticket-cat:' || o.id) < 0.85 THEN 'product_issue'
         ELSE 'billing'
       END AS category
FROM shop.orders AS o
WHERE pg_temp.rnd('ticket:' || o.id)
      < CASE o.status WHEN 'refunded' THEN 0.75 WHEN 'cancelled' THEN 0.30 ELSE 0.08 END
UNION ALL
SELECT 'account:' || i,
       c.id,
       NULL,
       c.signed_up_at + pg_temp.rnd('account-day:' || i) * (w.ends_at - c.signed_up_at),
       CASE WHEN pg_temp.rnd('account-cat:' || i) < 0.7 THEN 'account' ELSE 'other' END
FROM generate_series(1, 150) AS i
CROSS JOIN demo_window AS w
JOIN shop.customers AS c ON c.id = 1 + floor(pg_temp.rnd('account-customer:' || i) * 800)::int;

DELETE FROM ticket_seed USING demo_window AS w WHERE ticket_seed.created_at > w.ends_at;

INSERT INTO support.tickets
  (id, customer_id, order_id, agent_id, category, priority, status, subject,
   created_at, first_response_at, resolved_at, satisfaction_score)
SELECT row_number() OVER (ORDER BY t.created_at, t.key),
       t.customer_id,
       t.order_id,
       CASE
         WHEN timing.responded_at > w.ends_at THEN NULL
         WHEN t.priority IN ('urgent', 'high') AND pg_temp.rnd('tier:' || t.key) < 0.6
           THEN 6 + floor(pg_temp.rnd('agent:' || t.key) * 3)::int
         ELSE 1 + floor(pg_temp.rnd('agent:' || t.key) * 5)::int
       END,
       t.category,
       t.priority,
       CASE
         WHEN timing.responded_at > w.ends_at THEN 'open'
         WHEN timing.resolved_at > w.ends_at THEN 'pending'
         WHEN timing.resolved_at > w.ends_at - interval '3 days' THEN 'resolved'
         ELSE 'closed'
       END,
       t.subjects[1 + floor(pg_temp.rnd('subject:' || t.key) * cardinality(t.subjects))::int],
       t.created_at,
       CASE WHEN timing.responded_at <= w.ends_at THEN timing.responded_at END,
       CASE WHEN timing.resolved_at <= w.ends_at THEN timing.resolved_at END,
       CASE
         WHEN timing.resolved_at > w.ends_at OR pg_temp.rnd('csat-given:' || t.key) < 0.35 THEN NULL
         ELSE greatest(1, least(5,
                5 - floor(pg_temp.rnd('csat:' || t.key) * 2)::int
                  - CASE WHEN timing.resolved_at - t.created_at > interval '72 hours' THEN 2 ELSE 0 END
                  - CASE WHEN t.category = 'product_issue' THEN 1 ELSE 0 END))
       END
FROM (
  SELECT s.*,
         CASE
           WHEN pg_temp.rnd('priority:' || s.key) < 0.06 THEN 'urgent'
           WHEN pg_temp.rnd('priority:' || s.key) < 0.26 THEN 'high'
           WHEN pg_temp.rnd('priority:' || s.key) < 0.76 THEN 'normal'
           ELSE 'low'
         END AS priority,
         CASE s.category
           WHEN 'shipping' THEN ARRAY['Where is my order?', 'Package arrived damaged', 'Delivery delayed', 'Wrong delivery address']
           WHEN 'billing' THEN ARRAY['Charged twice', 'Refund not received', 'Discount code not applied', 'Need an invoice']
           WHEN 'product_issue' THEN ARRAY['Grinder stopped working', 'Beans tasted stale', 'Missing item in box', 'Kettle leaking']
           WHEN 'account' THEN ARRAY['Cannot reset password', 'Update email address', 'Cancel my subscription', 'Change subscription plan']
           ELSE ARRAY['Wholesale enquiry', 'Brewing advice', 'Feedback on the website']
         END AS subjects
  FROM ticket_seed AS s
) AS t
CROSS JOIN demo_window AS w
CROSS JOIN LATERAL (
  -- Higher priority gets faster responses and resolutions.
  SELECT t.created_at
           + (CASE t.priority WHEN 'urgent' THEN 10 WHEN 'high' THEN 30 WHEN 'normal' THEN 90 ELSE 240 END)
             * (0.3 + pg_temp.rnd('response:' || t.key) * 1.7) * interval '1 minute' AS responded_at,
         t.created_at
           + (CASE t.priority WHEN 'urgent' THEN 2 WHEN 'high' THEN 6 WHEN 'normal' THEN 12 ELSE 24 END
              + power(pg_temp.rnd('resolution:' || t.key), 1.5)
                * CASE t.priority WHEN 'urgent' THEN 8 WHEN 'high' THEN 24 WHEN 'normal' THEN 60 ELSE 140 END)
             * interval '1 hour' AS resolved_at
) AS timing;

CREATE INDEX tickets_customer_idx ON support.tickets (customer_id);
CREATE INDEX tickets_created_at_idx ON support.tickets (created_at);

ANALYZE shop.customers, shop.products, shop.orders, shop.order_items, support.agents, support.tickets;
`

const SUMMARY_SQL = `
SELECT (SELECT count(*) FROM shop.customers)::int AS customers,
       (SELECT count(*) FROM shop.products)::int AS products,
       (SELECT count(*) FROM shop.orders)::int AS orders,
       (SELECT count(*) FROM shop.order_items)::int AS order_items,
       (SELECT count(*) FROM support.agents)::int AS agents,
       (SELECT count(*) FROM support.tickets)::int AS tickets`

/** Drops and rebuilds the synthetic shop and support schemas in one transaction. */
export async function buildDemoSource(pool: Pool): Promise<DemoSourceSummary> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(BUILD_SQL)
    const { rows } = await client.query<{
      customers: number
      products: number
      orders: number
      order_items: number
      agents: number
      tickets: number
    }>(SUMMARY_SQL)
    await client.query("COMMIT")
    const row = rows[0]
    if (!row) throw new Error("Demo source summary returned no row")
    return {
      customers: row.customers,
      products: row.products,
      orders: row.orders,
      orderItems: row.order_items,
      agents: row.agents,
      tickets: row.tickets,
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

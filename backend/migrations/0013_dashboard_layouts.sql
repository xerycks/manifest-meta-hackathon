-- Dashboard layouts and charts (Cycle 15). Each panel gets a box on a
-- 12-column grid (column grid_x, row grid_y, grid_w columns wide, grid_h rows
-- tall) in place of its list position; boxes never overlap, which the
-- application checks. layout_version increases with every layout save, so a
-- layout based on an older one is rejected. Chart kinds join the panel kinds.

ALTER TABLE dashboards
  ADD COLUMN layout_version integer NOT NULL DEFAULT 1 CHECK (layout_version >= 1);

ALTER TABLE dashboard_panels
  ADD COLUMN grid_x integer,
  ADD COLUMN grid_y integer,
  ADD COLUMN grid_w integer,
  ADD COLUMN grid_h integer;

-- Existing panels keep their order, stacked down the left edge at their kind's
-- default size (number 3x2, table 12x4, Markdown 4x2).
WITH sized AS (
  SELECT id, workspace_id, dashboard_id, position, created_at,
         CASE kind WHEN 'number' THEN 3 WHEN 'table' THEN 12 ELSE 4 END AS w,
         CASE kind WHEN 'table' THEN 4 ELSE 2 END AS h
    FROM dashboard_panels
), placed AS (
  SELECT id, w, h,
         coalesce(sum(h) OVER (PARTITION BY workspace_id, dashboard_id ORDER BY position, created_at, id
                               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS y
    FROM sized
)
UPDATE dashboard_panels p
   SET grid_x = 0, grid_y = placed.y, grid_w = placed.w, grid_h = placed.h
  FROM placed
 WHERE p.id = placed.id;

ALTER TABLE dashboard_panels
  ALTER COLUMN grid_x SET NOT NULL,
  ALTER COLUMN grid_y SET NOT NULL,
  ALTER COLUMN grid_w SET NOT NULL,
  ALTER COLUMN grid_h SET NOT NULL,
  ADD CONSTRAINT dashboard_panels_grid_check CHECK (
    grid_x >= 0 AND grid_w BETWEEN 1 AND 12 AND grid_x + grid_w <= 12
    AND grid_y BETWEEN 0 AND 500 AND grid_h BETWEEN 1 AND 12
  );

-- Order now follows the grid: top to bottom, then left to right.
DROP INDEX dashboard_panels_order_idx;
ALTER TABLE dashboard_panels DROP COLUMN position;
CREATE INDEX dashboard_panels_order_idx ON dashboard_panels (workspace_id, dashboard_id, grid_y, grid_x);

ALTER TABLE dashboard_panels
  DROP CONSTRAINT dashboard_panels_kind_check,
  ADD CONSTRAINT dashboard_panels_kind_check
    CHECK (kind IN ('number', 'table', 'markdown', 'bar', 'line', 'gauge', 'ticker', 'sankey'));

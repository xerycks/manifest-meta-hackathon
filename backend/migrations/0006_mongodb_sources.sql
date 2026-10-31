-- MongoDB sources (Cycle 08). A MongoDB source's databases play the part of
-- schemas, its collections are manifest objects of kind 'collection' (views
-- stay 'view'), and the fields inferred from sampled documents are columns
-- named by dotted path. Engine-specific facts that do not fit the shared
-- columns live in details: for collections, how they were sampled; for
-- fields, every type seen and how often, so mixed and missing types are kept
-- rather than collapsed. Discovery writes details; people never edit them.

ALTER TABLE manifest_objects DROP CONSTRAINT manifest_objects_kind_check;
ALTER TABLE manifest_objects ADD CONSTRAINT manifest_objects_kind_check
  CHECK (kind IN ('table', 'view', 'materialized_view', 'partitioned_table', 'foreign_table', 'collection'));

ALTER TABLE manifest_objects
  ADD COLUMN details jsonb CHECK (details IS NULL OR jsonb_typeof(details) = 'object');

ALTER TABLE manifest_columns
  ADD COLUMN details jsonb CHECK (details IS NULL OR jsonb_typeof(details) = 'object');

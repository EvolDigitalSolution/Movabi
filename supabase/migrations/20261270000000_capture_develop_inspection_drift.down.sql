-- Rollback of 20261270000000_capture_develop_inspection_drift.sql: intentionally empty.
-- The column and the 6-argument function existed on develop before this migration and are kept
-- everywhere (instruction: capture, do not drop). Rolling the release back leaves them as they are.
SELECT 1 AS d12_rollback_keeps_develop_objects;

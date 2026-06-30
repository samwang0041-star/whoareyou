DELETE FROM "MetricSnapshot" snapshot
WHERE snapshot.ctid NOT IN (
  SELECT MAX(deduped.ctid)
  FROM "MetricSnapshot" deduped
  GROUP BY deduped."bucketStart", deduped."bucketSize"
);

CREATE UNIQUE INDEX IF NOT EXISTS "MetricSnapshot_bucketStart_bucketSize_key"
  ON "MetricSnapshot"("bucketStart", "bucketSize");

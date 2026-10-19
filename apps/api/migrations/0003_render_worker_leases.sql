-- Add worker lease/retry/progress metadata to the render queue.
-- This is a separate migration to keep 0002 immutable for installations that already applied it.
ALTER TABLE render_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10);
ALTER TABLE render_jobs ADD COLUMN lease_until INTEGER;
ALTER TABLE render_jobs ADD COLUMN worker_id TEXT;
ALTER TABLE render_jobs ADD COLUMN started_at TEXT;
ALTER TABLE render_jobs ADD COLUMN finished_at TEXT;
ALTER TABLE render_jobs ADD COLUMN output_size_bytes INTEGER;
CREATE INDEX IF NOT EXISTS idx_render_jobs_claim ON render_jobs(status, lease_until, created_at);

-- kruto52 — Pro-trial tracking.
--
-- Adds a single column to `users` recording when (if ever) the account
-- consumed its one-shot 24-hour Pro trial. The column stays NULL until
-- the user activates the trial — after that the trial cannot be granted
-- again. We compare on NULL/NOT NULL rather than on a flag column so the
-- value also serves as audit timestamp.

BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS pro_trial_used_at TIMESTAMPTZ;

COMMIT;

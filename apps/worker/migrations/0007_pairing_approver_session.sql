-- The sign-in session (its hash) that approved a pairing: approving again from that browser, as a retry after a lost
-- answer does, gets the device it made. Older Workers never read it.
ALTER TABLE pairings ADD COLUMN approved_session TEXT;

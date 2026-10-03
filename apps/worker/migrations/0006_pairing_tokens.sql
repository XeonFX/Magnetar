-- A device token waits in its pairing until the app confirms it, or connects with it: the connection finds the
-- pairing still holding it by device id.
CREATE INDEX pairings_uncollected ON pairings(device_id) WHERE device_token IS NOT NULL;

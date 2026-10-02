-- /features is the website's features page now (packages/protocol/src/device-names.json `reserved`): a device
-- already named so, in any case, steps aside as the Worker would name it today, with -device after it.
UPDATE devices SET name = name || '-device'
WHERE lower(name) = 'features'
  AND NOT EXISTS (SELECT 1 FROM devices other WHERE other.user_id = devices.user_id AND lower(other.name) = lower(devices.name) || '-device');

-- An account that has a Features-device already: six random hex digits after it keep the name its own (an id would
-- not do: an older one may hold hyphens or be too long for a name).
UPDATE devices SET name = name || '-device-' || lower(hex(randomblob(3))) WHERE lower(name) = 'features';

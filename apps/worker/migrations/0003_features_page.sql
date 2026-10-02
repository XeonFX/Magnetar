-- /features is the website's features page now (packages/protocol/src/device-names.json `reserved`): a device
-- already named so, in any case, steps aside as the Worker would name it today, with -device after it.
UPDATE devices SET name = name || '-device'
WHERE lower(name) = 'features'
  AND NOT EXISTS (SELECT 1 FROM devices other WHERE other.user_id = devices.user_id AND lower(other.name) = lower(devices.name) || '-device');

-- An account that has a Features-device already: the device's id after it keeps the name its own.
UPDATE devices SET name = name || '-device-' || replace(substr(id, 3), '_', '') WHERE lower(name) = 'features';

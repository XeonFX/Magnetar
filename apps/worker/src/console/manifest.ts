/**
 * What CodeFusion Console shows of magnetar.codefusion.cc (its docs/MANIFEST.md): the accounts and the devices
 * paired to them. The relay only ever carries end-to-end encrypted frames, so there is nothing about downloads
 * here to show. Fields marked `sensitive` reach only console members with pii:read; the console removes them.
 */
export const manifest = {
  manifestVersion: 1,
  app: { id: 'magnetar', name: 'Magnetar', description: 'Remote dashboard, pairing and relay for the Magnetar desktop app.' },
  resources: [
    {
      key: 'accounts',
      label: 'Account',
      labelPlural: 'Accounts',
      icon: 'users',
      titleKey: 'id',
      fields: [
        { key: 'id', label: 'ID', type: 'id' },
        { key: 'email', label: 'Email', type: 'text', sensitive: true },
        { key: 'name', label: 'Name', type: 'text', sensitive: true },
        { key: 'devices', label: 'Devices', type: 'number' },
        { key: 'sessions', label: 'Signed-in browsers', type: 'number' },
        { key: 'created_at', label: 'Created', type: 'datetime' },
        { key: 'last_login_at', label: 'Last sign-in', type: 'datetime' },
      ],
      list: {
        columns: ['email', 'name', 'devices', 'last_login_at'],
        search: { placeholder: 'Account id, email or name' },
        sortable: ['last_login_at', 'created_at', 'devices'],
        defaultSort: { key: 'last_login_at', dir: 'desc' },
        pageSize: 25,
      },
      detail: {
        sections: [
          { title: 'Account', fields: ['email', 'name', 'created_at', 'last_login_at'] },
          { title: 'Use', fields: ['devices', 'sessions'] },
        ],
      },
      actions: [
        {
          key: 'sign-out',
          label: 'Sign out everywhere',
          icon: 'door-open',
          permission: 'records:moderate',
          confirm: {
            title: 'Sign this account out everywhere?',
            message: 'Every browser signed in to this account has to sign in again. Paired devices stay paired.',
            confirmLabel: 'Sign out',
          },
        },
        {
          key: 'delete',
          label: 'Delete account',
          icon: 'trash',
          tone: 'danger',
          permission: 'records:manage',
          requireReason: true,
          confirm: {
            title: 'Delete this account?',
            message: 'The account, its sign-ins and every paired device are removed for good. Its devices are disconnected and have to be paired again.',
            confirmLabel: 'Delete',
          },
        },
      ],
    },
    {
      key: 'devices',
      label: 'Device',
      labelPlural: 'Devices',
      icon: 'radio',
      titleKey: 'id',
      fields: [
        { key: 'id', label: 'ID', type: 'id' },
        { key: 'name', label: 'Name', type: 'text', sensitive: true },
        { key: 'platform', label: 'Platform', type: 'text' },
        { key: 'version', label: 'App version', type: 'text' },
        { key: 'online', label: 'Online', type: 'boolean' },
        { key: 'account', label: 'Account', type: 'ref', ref: 'accounts' },
        { key: 'created_at', label: 'Paired', type: 'datetime' },
        { key: 'last_seen_at', label: 'Last seen', type: 'datetime' },
      ],
      list: {
        columns: ['name', 'platform', 'version', 'online', 'last_seen_at'],
        search: { placeholder: 'Device id, name or app version' },
        filters: [
          { key: 'online', label: 'Status', type: 'enum', options: [{ value: 'yes', label: 'Online', tone: 'success' }, { value: 'no', label: 'Offline' }] },
        ],
        sortable: ['last_seen_at', 'created_at'],
        defaultSort: { key: 'created_at', dir: 'desc' },
        pageSize: 25,
      },
      detail: {
        badge: 'online',
        sections: [
          { title: 'Device', fields: ['name', 'platform', 'version', 'online'] },
          { title: 'History', fields: ['created_at', 'last_seen_at', 'account'] },
        ],
      },
      actions: [
        {
          key: 'remove',
          label: 'Remove device',
          icon: 'trash',
          tone: 'danger',
          permission: 'records:moderate',
          scope: ['record', 'bulk'],
          requireReason: true,
          confirm: {
            title: 'Remove from its account?',
            message: 'The device is disconnected at once and has to be paired again, as when its owner removes it.',
            confirmLabel: 'Remove',
          },
        },
      ],
    },
  ],
} as const

import { env } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'
import { isDeviceName } from '@magnetar/protocol/device-name'
import rules from '../../../packages/protocol/src/device-names.json'
import { insertDevice, signIn, userId } from './client.ts'

/** Runs a migration again over rows written as they were before it. */
async function rerun(name: string) {
  const migration = env.TEST_MIGRATIONS.find(m => m.name.startsWith(name))!
  for (const query of migration.queries) await env.DB.prepare(query).run()
}

describe('0002: device names become addresses', () => {
  test('spells every existing name as an address, unique per account, oldest first', async () => {
    const [user, other] = await Promise.all([signIn().then(userId), signIn().then(userId)])
    await env.DB.prepare('DROP INDEX devices_user_name').run()
    const rows: Parameters<typeof insertDevice>[] = [
      ['d_m1', user, "Krystian's MacBook Pro", 1],
      ['d_m2', user, 'Studio Mac', 2],
      ['d_m3', user, 'studio   mac', 3],
      ['d_m4', user, 'Studio-Mac', 4],
      ['d_m5', user, ' -- ', 5],
      ['d_m6', user, 'login', 6],
      ['d_m7', user, `${'x'.repeat(39)} y ${'z'.repeat(18)}`, 7],
      ['d_m8', user, 'Łódź Straße', 8],
      ['d_m11', user, '电脑 d', 11],
      ['d_m9', other, 'Studio Mac', 9],
    ]
    for (const row of rows) await insertDevice(...row)

    await rerun('0002')

    const names = await env.DB.prepare("SELECT id, name FROM devices WHERE id LIKE 'd_m%' ORDER BY id").all<{ id: string; name: string }>()
    expect(Object.fromEntries(names.results.map(r => [r.id, r.name]))).toEqual({
      d_m1: 'Krystians-MacBook-Pro',
      d_m2: 'Studio-Mac',
      d_m3: 'studio-mac-2',
      d_m4: 'Studio-Mac-3',
      d_m5: 'Magnetar',
      d_m6: 'login-device',
      d_m7: 'x'.repeat(39),
      d_m8: 'Lodz-Strasse',
      d_m11: 'd-device',
      d_m9: 'Studio-Mac',
    })
    expect(names.results.every(r => isDeviceName(r.name))).toBe(true)
    await expect(insertDevice('d_m10', user, 'STUDIO-MAC', 10)).rejects.toThrow(/UNIQUE constraint failed/)
  })
})

describe('0003: index becomes the website\'s own word', () => {
  test('a device named index in any case gets -device, or the first free -2, -3… on its account', async () => {
    const [user, other] = await Promise.all([signIn().then(userId), signIn().then(userId)])
    const rows: Parameters<typeof insertDevice>[] = [
      ['d_i1', user, 'Index', 1],
      ['d_i2', user, 'index-DEVICE', 2],
      ['d_i3', user, 'Index-device-2', 3],
      ['d_i4', user, 'index-2', 4],
      ['d_i5', other, 'INDEX', 5],
    ]
    for (const row of rows) await insertDevice(...row)

    await rerun('0003')

    const names = await env.DB.prepare("SELECT id, name FROM devices WHERE id LIKE 'd_i%' ORDER BY id").all<{ id: string; name: string }>()
    expect(Object.fromEntries(names.results.map(r => [r.id, r.name]))).toEqual({
      d_i1: 'Index-device-3',
      d_i2: 'index-DEVICE',
      d_i3: 'Index-device-2',
      d_i4: 'index-2',
      d_i5: 'INDEX-device',
    })
    expect(names.results.every(r => isDeviceName(r.name))).toBe(true)
  })
})

describe('0004: features is the website\'s own word', () => {
  test('a device named features in any case gets -device, or the first free -2, -3… on its account', async () => {
    const [user, other] = await Promise.all([signIn().then(userId), signIn().then(userId)])
    const rows: Parameters<typeof insertDevice>[] = [
      ['d_f1', user, 'Features', 1],
      ['d_f2', user, 'features-DEVICE', 2],
      ['d_f3', user, 'Featuresmac', 3],
      ['d_f4', other, 'FEATURES', 4],
    ]
    for (const row of rows) await insertDevice(...row)

    await rerun('0004')

    const names = await env.DB.prepare("SELECT id, name FROM devices WHERE id LIKE 'd_f%' ORDER BY id").all<{ id: string; name: string }>()
    expect(Object.fromEntries(names.results.map(r => [r.id, r.name]))).toEqual({
      d_f1: 'Features-device-2',
      d_f2: 'features-DEVICE',
      d_f3: 'Featuresmac',
      d_f4: 'FEATURES-device',
    })
    expect(names.results.every(r => isDeviceName(r.name))).toBe(true)
  })
})

describe('the renaming migrations together', () => {
  test('step around every word the website keeps for itself, as the Worker does', async () => {
    const owner = await signIn().then(userId)
    await env.DB.prepare('DROP INDEX devices_user_name').run()
    for (const [i, word] of rules.reserved.entries()) await insertDevice(`d_r${i}`, owner, word.toUpperCase(), i)
    for (const migration of ['0002', '0003', '0004']) await rerun(migration)
    const names = await env.DB.prepare("SELECT name FROM devices WHERE id LIKE 'd_r%' ORDER BY created_at").all<{ name: string }>()
    expect(names.results.map(r => r.name)).toEqual(rules.reserved.map(word => `${word.toUpperCase()}-device`))
  })
})

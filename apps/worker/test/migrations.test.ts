import { env } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'
import { isDeviceName } from '@magnetar/protocol/device-name'
import rules from '../../../packages/protocol/src/device-names.json'
import { signIn } from './client.ts'

/** Runs a migration again over rows written as they were before it. */
async function rerun(name: string) {
  const migration = env.TEST_MIGRATIONS.find(m => m.name.startsWith(name))!
  for (const query of migration.queries) await env.DB.prepare(query).run()
}

describe('0002: device names become addresses', () => {
  test('spells every existing name as an address, unique per account, oldest first', async () => {
    const [user, other] = await Promise.all([signIn(), signIn()])
    const ids = await env.DB.prepare('SELECT id, email FROM users WHERE email IN (?, ?)').bind(user.email, other.email).all<{ id: string; email: string }>()
    const userId = (email: string) => ids.results.find(r => r.email === email)!.id
    await env.DB.prepare('DROP INDEX devices_user_name').run()
    const rows: [string, string, string, number][] = [
      ['d_m1', userId(user.email), "Krystian's MacBook Pro", 1],
      ['d_m2', userId(user.email), 'Studio Mac', 2],
      ['d_m3', userId(user.email), 'studio   mac', 3],
      ['d_m4', userId(user.email), 'Studio-Mac', 4],
      ['d_m5', userId(user.email), ' -- ', 5],
      ['d_m6', userId(user.email), 'login', 6],
      ['d_m7', userId(user.email), `${'x'.repeat(39)} y ${'z'.repeat(18)}`, 7],
      ['d_m8', userId(user.email), 'Łódź Straße', 8],
      ['d_m11', userId(user.email), '电脑 d', 11],
      ['d_m9', userId(other.email), 'Studio Mac', 9],
    ]
    for (const [id, owner, name, at] of rows) {
      await env.DB.prepare('INSERT INTO devices (id, user_id, name, platform, version, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, owner, name, 'macos', '1.0.0', `hash-${id}`, at).run()
    }

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
    await expect(env.DB.prepare('INSERT INTO devices (id, user_id, name, platform, version, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('d_m10', userId(user.email), 'STUDIO-MAC', 'macos', '1', 'hash-d_m10', 10).run()).rejects.toThrow(/UNIQUE constraint failed/)
  })

  test('steps around every word the website keeps for itself, as the Worker does', async () => {
    const user = await signIn()
    const owner = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(user.email).first<{ id: string }>())!.id
    await env.DB.prepare('DROP INDEX devices_user_name').run()
    for (const [i, word] of rules.reserved.entries()) {
      await env.DB.prepare('INSERT INTO devices (id, user_id, name, platform, version, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(`d_r${i}`, owner, word.toUpperCase(), 'macos', '1', `hash-r${i}`, i).run()
    }
    await rerun('0002')
    // Words reserved later step aside in their own migration.
    await rerun('0003')
    const names = await env.DB.prepare("SELECT name FROM devices WHERE id LIKE 'd_r%' ORDER BY created_at").all<{ name: string }>()
    expect(names.results.map(r => r.name)).toEqual(rules.reserved.map(word => `${word.toUpperCase()}-device`))
  })
})

describe('0003: /features is the website\'s', () => {
  test('renames a device called features in any case, around a name its account already has', async () => {
    const [first, second, third] = await Promise.all([signIn(), signIn(), signIn()])
    const ids = await env.DB.prepare('SELECT id, email FROM users WHERE email IN (?, ?, ?)').bind(first.email, second.email, third.email).all<{ id: string; email: string }>()
    const owner = (email: string) => ids.results.find(r => r.email === email)!.id
    const rows: [string, string, string][] = [
      ['d_f1', owner(first.email), 'Features'],
      ['d_f2', owner(second.email), 'features-device'],
      ['d_f3', owner(second.email), 'FEATURES'],
      ['d_f4', owner(second.email), 'features-2'],
      ['d_f_5', owner(first.email), 'Featuresmac'],
      // An older id, with a hyphen and an underscore.
      ['d_-f_6', owner(third.email), 'Features'],
      ['d_f7', owner(third.email), 'features-device'],
    ]
    for (const [id, user, name] of rows) {
      await env.DB.prepare('INSERT INTO devices (id, user_id, name, platform, version, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, user, name, 'macos', '1.1.0', `hash-${id}`, 1).run()
    }

    await rerun('0003')

    const names = await env.DB.prepare("SELECT id, name FROM devices WHERE id LIKE 'd_f%' OR id = 'd_-f_6' ORDER BY id").all<{ id: string; name: string }>()
    expect(Object.fromEntries(names.results.map(r => [r.id, r.name]))).toEqual({
      d_f1: 'Features-device',
      d_f2: 'features-device',
      d_f3: expect.stringMatching(/^FEATURES-device-[0-9a-f]{6}$/),
      d_f4: 'features-2',
      'd_-f_6': expect.stringMatching(/^Features-device-[0-9a-f]{6}$/),
      d_f_5: 'Featuresmac',
      d_f7: 'features-device',
    })
    expect(names.results.every(r => isDeviceName(r.name))).toBe(true)
  })
})

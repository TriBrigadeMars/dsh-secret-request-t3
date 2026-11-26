import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FileDelivery } from '../dist/files.js'

/** Fresh throwaway value per test; never a real-looking credential. */
const freshValue = () => 'ts_' + randomBytes(16).toString('hex')

const posix = process.platform !== 'win32'

const setup = async (t, options = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-secret-files-test-'))
  const files = new FileDelivery({ tmpRoot: root, ...options })
  t.after(async () => {
    await files.disposeAll()
    await rm(root, { recursive: true, force: true })
  })
  return files
}

const missing = async (path) => {
  try {
    await stat(path)
    return false
  } catch (error) {
    assert.equal(error.code, 'ENOENT')
    return true
  }
}

await test('POSIX: creates a 0700 directory holding a 0600 file, then removes both', { skip: !posix }, async (t) => {
  const files = await setup(t)
  const value = freshValue()
  const file = await files.create({ sessionId: 'session-a', callId: 'call-a', value, ttlMs: 60_000 })

  assert.equal(file.atRest, 'posix-0600')
  assert.equal((await stat(file.directory)).mode & 0o777, 0o700)
  assert.equal((await stat(file.path)).mode & 0o777, 0o600)
  assert.equal(await readFile(file.path, 'utf8'), value)
  assert.ok(!file.path.includes(value))
  assert.ok(!JSON.stringify(file).includes(value))
  assert.equal(file.sessionId, 'session-a')
  assert.equal(file.callId, 'call-a')
  assert.ok(file.expiresAt > Date.now())
  assert.ok(file.path.startsWith(file.directory))

  await files.remove(file)
  assert.equal(await missing(file.path), true)
  assert.equal(await missing(file.directory), true)
})

await test('POSIX: removeReferenced deletes only the matching session and path', { skip: !posix }, async (t) => {
  const files = await setup(t)
  const first = await files.create({ sessionId: 'session-a', callId: 'call-1', value: freshValue(), ttlMs: 60_000 })
  const second = await files.create({ sessionId: 'session-a', callId: 'call-2', value: freshValue(), ttlMs: 60_000 })
  const other = await files.create({ sessionId: 'session-b', callId: 'call-3', value: freshValue(), ttlMs: 60_000 })

  const removed = await files.removeReferenced('session-a', `curl --config ${first.path}`)
  assert.deepEqual(removed, [first.path])
  assert.equal(await missing(first.path), true)
  assert.equal(await missing(first.directory), true)
  assert.equal(await missing(second.path), false)
  assert.equal(await missing(other.path), false)

  // A different session naming the very same path cannot remove it.
  assert.deepEqual(await files.removeReferenced('session-c', second.path), [])
  assert.equal(await missing(second.path), false)
})

await test('injected win32: delivery succeeds and reports the ACL fallback', async (t) => {
  const files = await setup(t, { platform: 'win32' })
  const value = freshValue()
  const file = await files.create({ sessionId: 'session-a', callId: 'call-a', value, ttlMs: 60_000 })

  if (posix) {
    // On Linux `icacls` does not exist, so hardening must fail open, not throw.
    assert.equal(file.atRest, 'unrestricted')
  } else {
    assert.ok(file.atRest === 'windows-acl' || file.atRest === 'unrestricted')
  }
  assert.equal(await readFile(file.path, 'utf8'), value)
  assert.ok(!JSON.stringify(file).includes(value))

  await files.remove(file)
  assert.equal(await missing(file.path), true)
  assert.equal(await missing(file.directory), true)
})

await test('disposeAll removes every tracked file', { skip: !posix }, async (t) => {
  const files = await setup(t)
  const first = await files.create({ sessionId: 'session-a', callId: 'call-1', value: freshValue(), ttlMs: 60_000 })
  const second = await files.create({ sessionId: 'session-b', callId: 'call-2', value: freshValue(), ttlMs: 60_000 })
  await files.disposeAll()
  assert.equal(await missing(first.directory), true)
  assert.equal(await missing(second.directory), true)
})

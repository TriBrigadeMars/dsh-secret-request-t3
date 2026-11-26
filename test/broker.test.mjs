import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { SecretBroker, SecretRefError } from '../dist/broker.js'

/** Fresh throwaway value per test; never a real-looking credential. */
const freshValue = () => 'ts_' + randomBytes(16).toString('hex')

const code = (expected) => (error) => error instanceof SecretRefError && error.code === expected

const mint = (broker, value, ttlMs = 60_000) =>
  broker.mint({ sessionId: 'session-a', callId: 'call-a', value, ttlMs })

await test('한 번만 소비할 수 있고 두 번째 소비는 consumed로 거부한다', () => {
  const broker = new SecretBroker()
  const value = freshValue()
  const { secretRef, expiresAt } = mint(broker, value)
  assert.match(secretRef, /^sr_[A-Za-z0-9_-]{32}$/)
  assert.ok(expiresAt > Date.now())
  assert.equal(broker.consume(secretRef, 'session-a'), value)
  assert.throws(() => broker.consume(secretRef, 'session-a'), code('consumed'))
  broker.dispose()
})

await test('다른 세션은 소비하지 못하고 올바른 세션은 계속 소비할 수 있다', () => {
  const broker = new SecretBroker()
  const value = freshValue()
  const { secretRef } = mint(broker, value)
  assert.throws(() => broker.consume(secretRef, 'session-b'), code('session_mismatch'))
  assert.equal(broker.consume(secretRef, 'session-a'), value)
  broker.dispose()
})

await test('만료된 참조는 expired로 거부하고 값을 보관하지 않는다', async () => {
  const broker = new SecretBroker()
  const value = freshValue()
  const { secretRef } = mint(broker, value, 50)
  await delay(80)
  assert.throws(() => broker.consume(secretRef, 'session-a'), code('expired'))
  assert.throws(() => broker.consume(secretRef, 'session-a'), code('expired'))
  broker.dispose()
})

await test('expire는 값을 지우고 이후 소비를 expired로 만든다', () => {
  const broker = new SecretBroker()
  const value = freshValue()
  const { secretRef } = mint(broker, value)
  broker.expire(secretRef)
  assert.throws(() => broker.consume(secretRef, 'session-a'), code('expired'))
  broker.dispose()
})

await test('알 수 없는 참조는 unknown으로 거부한다', () => {
  const broker = new SecretBroker()
  assert.throws(() => broker.consume('sr_not-a-real-handle', 'session-a'), code('unknown'))
  broker.dispose()
})

await test('dispose 이후 살아 있던 참조는 unknown이 된다', () => {
  const broker = new SecretBroker()
  const { secretRef } = mint(broker, freshValue())
  broker.dispose()
  assert.throws(() => broker.consume(secretRef, 'session-a'), code('unknown'))
})

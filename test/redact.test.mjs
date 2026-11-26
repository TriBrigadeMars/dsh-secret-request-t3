import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { REDACTION, Redactor } from '../dist/redact.js'

/**
 * Fresh throwaway value per test. It deliberately contains URL-encodable and
 * base64-relevant characters so every tracked encoding differs from the raw
 * form. Never a real-looking credential, and never written to a fixture.
 */
const freshValue = () => 'ts_' + randomBytes(12).toString('hex') + '/+=&? '

/** Every encoding `Redactor` is expected to track, including the raw value. */
const variantsOf = (value) => {
  const bytes = Buffer.from(value)
  return [
    value,
    bytes.toString('base64'),
    bytes.toString('base64url'),
    encodeURIComponent(value),
    encodeURI(value),
  ]
}

await test('원문, base64, base64url, encodeURIComponent, encodeURI 인코딩을 모두 지운다', () => {
  const value = freshValue()
  const redactor = new Redactor()
  redactor.add(value)

  const base64 = Buffer.from(value).toString('base64')
  const base64url = Buffer.from(value).toString('base64url')
  const component = encodeURIComponent(value)
  const uri = encodeURI(value)
  // The fixture only earns these distinct encodings when it needs escaping.
  assert.notEqual(component, value)
  assert.notEqual(uri, value)

  const text = [
    `raw ${value} raw`,
    `base64 ${base64} base64`,
    `base64url ${base64url} base64url`,
    `component ${component} component`,
    `uri ${uri} uri`,
  ].join('\n')
  const scrubbed = redactor.scrub(text)

  assert.equal(
    scrubbed,
    [
      `raw ${REDACTION} raw`,
      `base64 ${REDACTION} base64`,
      `base64url ${REDACTION} base64url`,
      `component ${REDACTION} component`,
      `uri ${REDACTION} uri`,
    ].join('\n')
  )
  for (const variant of variantsOf(value)) assert.ok(!scrubbed.includes(variant))
})

await test('중첩된 인코딩 텍스트에서도 값의 흔적을 남기지 않는다', () => {
  const value = freshValue()
  const redactor = new Redactor()
  redactor.add(value)

  const component = encodeURIComponent(value)
  const text = `url=https://example.test/?token=${component}&state=ok`
  const scrubbed = redactor.scrub(text)
  assert.equal(scrubbed, `url=https://example.test/?token=${REDACTION}&state=ok`)
  assert.ok(!scrubbed.includes(component))
})

await test('4자 미만 값은 과잉 삭제를 피하려고 무시하고 4자 값은 추적한다', () => {
  const redactor = new Redactor()
  for (const short of ['', 'a', 'ab', 'abc']) redactor.add(short)
  assert.equal(redactor.scrub('ok yes a/b abc'), 'ok yes a/b abc')

  redactor.add('abcd')
  assert.equal(redactor.scrub('value=abcd;'), `value=${REDACTION};`)
})

await test('같은 값을 두 번 추가해도 한 번만 추적한다', () => {
  const value = freshValue()
  const redactor = new Redactor()
  redactor.add(value)
  redactor.add(value)
  assert.equal(redactor.scrub(value), REDACTION)
})

await test('dispose는 추적 값과 타이머를 지우고 이후 삭제를 멈춘다', () => {
  const value = freshValue()
  const redactor = new Redactor()
  redactor.add(value)
  redactor.dispose()
  assert.equal(redactor.scrub(value), value)
  // A second dispose is harmless.
  redactor.dispose()
  assert.equal(redactor.scrub(encodeURIComponent(value)), encodeURIComponent(value))
})

await test('지정한 TTL이 지나면 추적을 멈춘다', async () => {
  const value = freshValue()
  const redactor = new Redactor()
  redactor.add(value, 30)
  assert.equal(redactor.scrub(value), REDACTION)
  await delay(60)
  // The old fixed ten-minute lifetime would still scrub here.
  assert.equal(redactor.scrub(value), value)
})

await test('같은 값을 더 긴 TTL로 다시 추가하면 추적 기한을 연장한다', async () => {
  const value = freshValue()
  const redactor = new Redactor()
  redactor.add(value, 30)
  redactor.add(value, 400)
  await delay(70)
  // The old early return kept the first 30 ms deadline and would leak here.
  assert.equal(redactor.scrub(value), REDACTION)
  redactor.dispose()
})

await test('같은 값을 더 짧은 TTL로 다시 추가해도 추적 기한을 줄이지 않는다', async () => {
  const value = freshValue()
  const redactor = new Redactor()
  redactor.add(value, 400)
  redactor.add(value, 10)
  await delay(50)
  assert.equal(redactor.scrub(value), REDACTION)
  redactor.dispose()
})

await test('hasMatch는 추적된 값이 텍스트에 남았는지 알려준다', () => {
  const value = freshValue()
  const redactor = new Redactor()
  redactor.add(value)
  assert.equal(redactor.hasMatch(`prefix ${value} suffix`), true)
  assert.equal(redactor.hasMatch(`prefix ${Buffer.from(value).toString('base64')} suffix`), true)
  assert.equal(redactor.hasMatch('unrelated text'), false)
  // The length floor keeps ordinary short output from blocking.
  redactor.add('abcd')
  assert.equal(redactor.hasMatch('value=abcd', 8), false)
  assert.equal(redactor.hasMatch('value=abcd', 4), true)
  redactor.dispose()
  assert.equal(redactor.hasMatch(value), false)
})

await test('요청한 긴 TTL 동안에는 값이 계속 지워진다', async () => {
  const value = freshValue()
  const redactor = new Redactor()
  redactor.add(value, 60_000)
  await delay(50)
  assert.equal(redactor.scrub(value), REDACTION)
  redactor.dispose()
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')

await test('승인 화면은 모든 로케일에서 오해를 부르는 에이전트 텍스트와 서버에 바인딩된 대상을 구분해 식별한다', async () => {
  for (const [locale, label] of [
    ['en', 'Credential storage reference'],
    ['ko', '비밀값 저장 참조'],
    ['zh', '凭据存储引用'],
    ['ja-JP', '認証情報の保存先参照'],
    ['es-ES', 'Referencia de almacenamiento de credenciales'],
    ['fr-FR', 'Référence de stockage des identifiants'],
    ['de-DE', 'Speicherreferenz der Zugangsdaten'],
    ['ru-RU', 'Ссылка на хранилище учётных данных'],
    ['pt-BR', 'Referência de armazenamento de credenciais'],
    ['xx-XX', 'Credential storage reference'],
  ]) {
    const request = {
      id: 'request-id',
      sessionId: 'session',
      callId: 'call',
      ref: 'PRODUCTION_TOKEN',
      label: '\u202eHarmless test token',
      reason: 'Save only a test token',
      configured: true,
    }
    let card, plugin
    const effects = []
    const jsx = (type, props) => (typeof type === 'function' ? type(props) : { type, props })
    runInNewContext(source, {
      AbortController,
      URL,
      setTimeout: () => 1,
      clearTimeout: () => {},
      document: { createElement: () => ({ remove() {} }), head: { append() {} } },
      window: {
        __ModuleLoader__: {
          load({ factory }) {
            plugin = factory((name) => {
              if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
              if (name === 'react')
                return {
                  useCallback: (callback) => callback,
                  useRef: () => ({ current: null }),
                  useEffect: () => {},
                  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
                  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
                }
              throw new Error(`Unexpected dependency: ${name}`)
            })
          },
        },
      },
    })
    const connection = { interactions: 'answer', rpc: { call: async () => ({ ok: true, value: [request] }) } }
    plugin.apply({
      get: () => connection,
      locale: { getSnapshot: () => ({ active: locale }), subscribe: () => () => {} },
      slots: {
        inject: (_name, callback) => callback(),
        register: (_spec, component) => {
          card = component
        },
      },
      effect: (effect) => effects.push(effect()),
    })
    await new Promise(setImmediate)
    const tree = card({
      sessionId: 'session',
      callId: 'call',
      phase: 'running',
      block: { args: { text: () => 'DECEPTIVE_TARGET' } },
    })
    const nodes = []
    const visit = (node) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(visit)
      nodes.push(node)
      visit(node.props?.children)
    }
    visit(tree)
    const refs = nodes.filter((node) => node.type === 'bdi')
    assert.equal(refs.length, 2, 'both target and replacement warning identify the immutable ref')
    for (const node of refs) {
      assert.equal(node.props.dir, 'ltr')
      assert.equal(node.props.children, request.ref)
    }
    assert.ok(JSON.stringify(tree).includes(label))
    assert.ok(!JSON.stringify(tree).includes('DECEPTIVE_TARGET'))
    assert.equal(
      nodes.find((node) => node.type === 'input').props['aria-describedby'],
      'secret-target-request-id secret-privacy-request-id'
    )
    assert.ok(
      nodes.some((node) => node.props?.className === 'dsh-secret-context' && node.props.children === request.label)
    )
    effects.forEach((dispose) => dispose?.())
  }
})

await test('모든 지원 로케일은 같은 메타데이터와 입력 카드 키 및 비어 있지 않은 번역을 제공한다', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const english = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'))
  for (const language of ['en', 'ko', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt']) {
    const locale = JSON.parse(await readFile(new URL(`../locale/${language}.json`, import.meta.url), 'utf8'))
    assert.deepEqual(Object.keys(locale).sort(), Object.keys(english).sort())
    for (const section of ['meta', 'ui']) {
      assert.deepEqual(Object.keys(locale[section]).sort(), Object.keys(english[section]).sort())
      assert.ok(Object.values(locale[section]).every((value) => typeof value === 'string' && value.trim()))
    }
    assert.ok(manifest.market.title[language]?.trim())
    assert.ok(manifest.market.description[language]?.trim())
    if (!['en', 'ko', 'zh'].includes(language)) assert.equal(manifest.market.title[language], locale.meta.title)
  }
})

await test('모든 지원 로케일의 기존 모드 안내는 저장 위치를 말하고 에이전트 가시성을 약속하지 않는다', async () => {
  const expected = {
    en: 'This value goes to the host credential store, not into the chat.',
    ko: '이 값은 채팅이 아니라 호스트 자격 증명 저장소로 전달됩니다.',
    zh: '该值会写入主机的凭据存储，而不会进入聊天。',
    ja: 'この値はチャットではなく、ホストの認証情報ストアに保存されます。',
    es: 'Este valor va al almacén de credenciales del host, no al chat.',
    fr: 'Cette valeur est envoyée au stockage des identifiants de l’hôte, pas dans la conversation.',
    de: 'Dieser Wert wird im Anmeldedatenspeicher des Hosts gespeichert, nicht im Chat.',
    ru: 'Это значение сохраняется в хранилище учётных данных хоста, а не в чате.',
    pt: 'Este valor vai para o armazenamento de credenciais do host, não para o chat.',
  }
  for (const [language, privacy] of Object.entries(expected)) {
    const locale = JSON.parse(await readFile(new URL(`../locale/${language}.json`, import.meta.url), 'utf8'))
    assert.equal(locale.ui.privacy, privacy)
    // Legacy mode writes plaintext to the host store that sandboxes can read.
    assert.ok(!/not shown to the agent/i.test(locale.ui.privacy))
  }
})

const english = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8')).ui

/** Mount the real built client plugin and return its registered tool-call card. */
async function mountCard(request) {
  let card
  let plugin
  const effects = []
  const jsx = (type, props) => (typeof type === 'function' ? type(props) : { type, props })
  runInNewContext(source, {
    AbortController,
    URL,
    setTimeout: () => 1,
    clearTimeout: () => {},
    document: { createElement: () => ({ remove() {} }), head: { append() {} } },
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          plugin = factory((name) => {
            if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
            if (name === 'react')
              return {
                useCallback: (callback) => callback,
                useRef: () => ({ current: null }),
                useEffect: () => {},
                useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
                useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
              }
            throw new Error(`Unexpected dependency: ${name}`)
          })
        },
      },
    },
  })
  const connection = {
    interactions: 'answer',
    rpc: { call: async () => ({ ok: true, value: request ? [request] : [] }) },
  }
  plugin.apply({
    get: () => connection,
    locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} },
    slots: {
      inject: (_name, callback) => callback(),
      register: (_spec, component) => {
        card = component
      },
    },
    effect: (effect) => effects.push(effect()),
  })
  await new Promise(setImmediate)
  return { card, effects }
}

function collect(tree) {
  const nodes = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(visit)
    nodes.push(node)
    visit(node.props?.children)
  }
  visit(tree)
  return nodes
}

const runningBlock = () => ({ args: { text: () => 'DECEPTIVE_TARGET' }, content: [] })

await test('실행 중인 카드는 열기 링크·플레이스홀더·일회용 안내·만료 힌트를 표시한다', async () => {
  const request = {
    id: 'request-id',
    sessionId: 'session',
    callId: 'call',
    ref: 'PRODUCTION_TOKEN',
    label: 'Harmless test token',
    reason: 'Save only a test token',
    configured: true,
    delivery: 'secretRef',
    expiresAt: Date.now() + 60_000,
    url: 'https://example.com/login',
    placeholder: 'sk-…',
  }
  const { card, effects } = await mountCard(request)
  const tree = card({ sessionId: 'session', callId: 'call', phase: 'running', block: runningBlock() })
  const nodes = collect(tree)
  const anchor = nodes.find((node) => node.type === 'a')
  assert.ok(anchor, 'a link to the credential page is rendered')
  assert.equal(anchor.props.href, 'https://example.com/login')
  assert.equal(anchor.props.target, '_blank')
  assert.match(anchor.props.rel, /noopener/)
  assert.match(anchor.props.rel, /noreferrer/)
  assert.equal(anchor.props.children, `${english.openUrl} · example.com`)
  assert.notEqual(anchor.props.type, 'submit', 'the link never submits the form')
  const input = nodes.find((node) => node.type === 'input')
  assert.equal(input.props.placeholder, 'sk-…')
  assert.equal(input.props.type, 'password')
  const rendered = JSON.stringify(tree)
  assert.ok(rendered.includes(english.oneUse), 'secretRef shows the one-use note')
  assert.ok(!rendered.includes(english.fileNote), 'file note is not shown for secretRef')
  assert.ok(rendered.includes(english.expiresIn.split('{seconds}')[0]), 'remaining time hint is rendered')
  assert.ok(!rendered.includes('{seconds}'), 'locale token is substituted')
  effects.forEach((dispose) => dispose?.())
})

await test('열기 링크는 모델이 준 URL의 호스트를 표시하고 잘못된 URL에도 던지지 않는다', async () => {
  const base = {
    id: 'request-id',
    sessionId: 'session',
    callId: 'call',
    label: 'Harmless test token',
    reason: 'Save only a test token',
    configured: false,
    delivery: 'secretRef',
    expiresAt: Date.now() + 60_000,
  }
  const valid = await mountCard({ ...base, url: 'https://example.com/login' })
  const validTree = valid.card({ sessionId: 'session', callId: 'call', phase: 'running', block: runningBlock() })
  const validAnchor = collect(validTree).find((node) => node.type === 'a')
  assert.equal(validAnchor.props.children, `${english.openUrl} · example.com`)
  valid.effects.forEach((dispose) => dispose?.())

  const malformed = await mountCard({ ...base, url: 'not a url' })
  const malformedTree = malformed.card({
    sessionId: 'session',
    callId: 'call',
    phase: 'running',
    block: runningBlock(),
  })
  const malformedAnchor = collect(malformedTree).find((node) => node.type === 'a')
  assert.ok(malformedAnchor, 'a malformed url still renders the link label')
  assert.equal(malformedAnchor.props.children, english.openUrl)
  malformed.effects.forEach((dispose) => dispose?.())
})

await test('만료된 결과 카드는 만료 상태와 재요청 안내를 표시한다', async () => {
  const { card, effects } = await mountCard(null)
  const tree = card({
    sessionId: 'session',
    callId: 'call',
    phase: 'result',
    block: {
      args: { text: () => 'Harmless test token' },
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ status: 'timed_out' }) }],
    },
  })
  const rendered = JSON.stringify(tree)
  assert.ok(rendered.includes(english.timed_out), 'expired status is shown')
  assert.ok(rendered.includes(english.expiredHint), 'expired hint asks for a new request')
  effects.forEach((dispose) => dispose?.())
})

await test('기존 요청은 기존 개인정보 안내만 표시하고 일회용·파일 안내는 숨긴다', async () => {
  const request = {
    id: 'request-id',
    sessionId: 'session',
    callId: 'call',
    label: 'Harmless test token',
    reason: 'Save only a test token',
    configured: false,
  }
  const { card, effects } = await mountCard(request)
  const tree = card({ sessionId: 'session', callId: 'call', phase: 'running', block: runningBlock() })
  const rendered = JSON.stringify(tree)
  assert.ok(rendered.includes(english.privacy), 'legacy privacy note still renders')
  assert.ok(!rendered.includes(english.oneUse), 'no one-use note for legacy requests')
  assert.ok(!rendered.includes(english.fileNote), 'no file note for legacy requests')
  const input = collect(tree).find((node) => node.type === 'input')
  assert.equal(input.props.placeholder, english.value)
  effects.forEach((dispose) => dispose?.())
})

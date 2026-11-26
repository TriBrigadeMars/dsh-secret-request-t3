import { defineConfig, type UserConfig } from 'tsdown'
import manifest from './package.json' with { type: 'json' }

const nodeConfig = {
  entry: ['src/index.ts', 'src/broker.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node24',
  fixedExtension: false,
  dts: false,
} satisfies UserConfig

// Harness loads browser plugins through its ModuleLoader, not ESM imports.
const clientConfig: UserConfig = {
  entry: ['src/client.tsx'],
  format: 'cjs',
  platform: 'browser',
  inputOptions: { platform: 'browser' },
  target: 'es2023',
  outExtensions: () => ({ js: '.js' }),
  dts: false,
  deps: { neverBundle: ['react', 'react/jsx-runtime'] },
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory(require) { const module = { exports: {} }; const exports = module.exports;`,
  footer: 'return module.exports; } });',
}

export default defineConfig([nodeConfig, clientConfig])

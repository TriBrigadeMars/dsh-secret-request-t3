import assert from 'node:assert/strict'

/**
 * Collect every decoded string value from a parsed JSON value.
 *
 * The persistence format is JSON, so a value containing `"` or `\` is escaped
 * in the bytes on disk and a raw-byte search never sees it. Decoding first and
 * walking the string leaves is what catches an escaped echo. A line-oriented
 * tool additionally splits a value across leaves, so callers compare each leaf
 * and the test's variant list includes the split pieces.
 */
export const strings = (value, out = []) => {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out))
  else if (value !== null && typeof value === 'object') Object.values(value).forEach((item) => strings(item, out))
  return out
}

/**
 * Assert no tracked variant occurs in any decoded string of `value`.
 *
 * `subject` names the artifact so a failure says which byte sink leaked.
 */
export const assertNoDecodedVariant = (value, variants, subject) => {
  for (const leaf of strings(value)) {
    for (const variant of variants) {
      assert.ok(!leaf.includes(variant), `${subject} leaked a secret variant in a decoded string`)
    }
  }
}

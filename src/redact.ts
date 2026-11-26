/**
 * Best-effort scrubbing of resolved secret values out of tool-result text.
 *
 * This is defence in depth, NOT a guarantee. A result that encodes a value in a
 * shape this module does not know, splits it across blocks, or hands it to a
 * tool that copies it somewhere else can still reach the session log. The
 * post-execute hook only sees the text a tool returns to the loop.
 */

/** Replacement text for every recognised value variant. */
export const REDACTION = '[redacted:secret]'

/**
 * Values shorter than this are not tracked. Scrubbing every 1-3 character
 * string would rewrite unrelated output ("ok", "yes", "a/b") into noise while
 * adding almost no protection for anything that looks like a credential.
 */
const minTrackedLength = 4

/** A tracked value is forgotten ten minutes after `add`. */
const ttlMs = 10 * 60 * 1000

interface Entry {
  /** Unique encodings of one submitted value, longest first. */
  readonly variants: readonly string[]
  readonly timer: { unref?: () => void }
}

/**
 * Track submitted values and replace their known encodings in text.
 *
 * Replacement is plain substring replacement: no regular expression is ever
 * built from the value, so no metacharacter in a secret can change the match.
 */
export class Redactor {
  private readonly entries = new Map<string, Entry>()
  /** Union of every entry's variants, deduplicated and sorted longest-first. */
  private ordered: readonly string[] = []

  /**
   * Track one submitted value until {@link dispose} or its TTL.
   *
   * Stored encodings: the raw value, base64, base64url, `encodeURIComponent`,
   * and `encodeURI`. Adding the same value twice keeps the first TTL.
   */
  add(value: string): void {
    if (value.length < minTrackedLength) return
    if (this.entries.has(value)) return

    const bytes = Buffer.from(value)
    const variants = [...new Set([
      value,
      bytes.toString('base64'),
      bytes.toString('base64url'),
      encodeURIComponent(value),
      encodeURI(value),
    ])].sort((left, right) => right.length - left.length || left.localeCompare(right))

    const timer = setTimeout(() => this.drop(value), ttlMs)
    timer.unref?.()
    const entry: Entry = { variants, timer }
    this.entries.set(value, entry)
    this.rebuild()
  }

  /** Replace every tracked variant in `text`. Never throws on ordinary input. */
  scrub(text: string): string {
    let output = text
    for (const variant of this.ordered) {
      if (output.includes(variant)) output = output.split(variant).join(REDACTION)
    }
    return output
  }

  /** Clear every tracked value and its timer. */
  dispose(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer as NodeJS.Timeout)
    this.entries.clear()
    this.ordered = []
  }

  private drop(value: string): void {
    const entry = this.entries.get(value)
    if (entry === undefined) return
    clearTimeout(entry.timer as NodeJS.Timeout)
    this.entries.delete(value)
    this.rebuild()
  }

  private rebuild(): void {
    const all = new Set<string>()
    for (const entry of this.entries.values()) for (const variant of entry.variants) all.add(variant)
    this.ordered = [...all].sort((left, right) => right.length - left.length || left.localeCompare(right))
  }
}

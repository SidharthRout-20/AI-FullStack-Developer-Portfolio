/**
 * Citation post-processing for model answers.
 *
 * Models (especially open-weight ones) don't always follow the "[n]" convention, so we normalise:
 *  - gpt-oss native markers   "【2†L4-L7】"  → "[2]"
 *  - lists / ranges           "[1, 3]" "[2-5]" (any dash) → "[1][3]" / "[2][3][4][5]"
 *  - trailing "Sources:" / "References:" sections are removed (the UI shows source cards instead)
 *  - repeated adjacent markers "[1][1]" collapse to one
 * Then every "[n]" becomes a "#cite-n" link that the Markdown renderer turns into a chip.
 */

const DASH = '\\-\\u2010-\\u2015' // hyphen-minus + Unicode hyphens/dashes
const LIST_RE = new RegExp(`\\[(\\d{1,2}(?:\\s*[,${DASH}]\\s*\\d{1,2})+)\\]`, 'g')
const SPLIT_DASH = new RegExp(`[${DASH}]`)
// A final paragraph / line that starts with "Sources:" or "(References: …)".
const TRAILING_SOURCES = /\n+[ \t]*[*_]*\(?[*_]*\s*(?:sources?|references?|citations?)\s*[*_]*\s*:[\s\S]*$/i

function expandList(list: string): number[] {
  const out: number[] = []
  for (const part of list.split(',')) {
    const [a, b] = part.split(SPLIT_DASH).map((s) => Number(s.trim()))
    if (a === undefined || Number.isNaN(a)) continue
    if (b === undefined || Number.isNaN(b)) out.push(a)
    else for (let n = a; n <= Math.min(b, a + 20); n++) out.push(n)
  }
  return out
}

/** Normalise citation markers and drop redundant "Sources" sections (no links yet). */
export function cleanCitations(text: string): string {
  return text
    .replace(/【(\d{1,2})(?:†[^】]*)?】/g, '[$1]')
    .replace(LIST_RE, (_, list: string) =>
      expandList(list)
        .map((n) => `[${n}]`)
        .join(''),
    )
    .replace(TRAILING_SOURCES, '')
    .replace(/(\[\d{1,2}\])(?:\s*\1)+/g, '$1')
    .trimEnd()
}

/** Clean citations, then turn each "[n]" into a "#cite-n" Markdown link (rendered as a chip). */
export function linkCitations(text: string): string {
  return cleanCitations(text).replace(/\[(\d{1,2})\](?!\()/g, '[$1](#cite-$1)')
}

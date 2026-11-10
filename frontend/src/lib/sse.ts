import type { StreamEvent } from '../types'

/**
 * Incremental Server-Sent Events parser.
 *
 * We can't use the browser's EventSource because it only supports GET (our
 * chat endpoint is a POST with a JSON body), so we read the fetch() body
 * stream ourselves. Network chunks can split an event anywhere, so we buffer
 * until we see the blank-line delimiter.
 */
export function createSSEParser<T extends { event: string } = StreamEvent>(onEvent: (ev: T) => void) {
  let buffer = ''

  return (chunk: string) => {
    buffer += chunk.replace(/\r\n/g, '\n')
    let boundary: number
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      let name = 'message'
      const data: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
      if (!data.length) continue
      try {
        onEvent({ event: name, ...JSON.parse(data.join('\n')) } as T)
      } catch {
        // Ignore malformed frames rather than crashing the UI.
      }
    }
  }
}

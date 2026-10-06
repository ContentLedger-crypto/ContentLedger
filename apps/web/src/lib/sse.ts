export interface SseMessage {
  readonly event: string
  readonly data: string
}

/**
 * The gateway's stream is read with `fetch`, not `EventSource`, because only `fetch` sends
 * the session's `Authorization` header; this is the part of `EventSource` that is left.
 * `id` and `retry` are ignored: the stream keeps no state to resume from.
 */
export async function* sseMessages(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let event = ''
  let data: string[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffered += decoder.decode(value, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const ended of lines) {
        // CR alone is not taken as a line end: a CRLF cut between chunks would read as two.
        const line = ended.endsWith('\r') ? ended.slice(0, -1) : ended
        if (line === '') {
          if (data.length > 0) {
            yield { event: event === '' ? 'message' : event, data: data.join('\n') }
          }
          event = ''
          data = []
          continue
        }
        const colon = line.indexOf(':')
        if (colon === 0) continue
        const field = colon === -1 ? line : line.slice(0, colon)
        const raw = colon === -1 ? '' : line.slice(colon + 1)
        const value = raw.startsWith(' ') ? raw.slice(1) : raw
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
    }
  } finally {
    // A reader that stops early closes the connection rather than leaving it to drain.
    await reader.cancel().catch(() => undefined)
  }
}

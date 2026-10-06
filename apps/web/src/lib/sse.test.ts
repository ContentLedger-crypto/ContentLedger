import { describe, expect, it } from 'vitest'
import { type SseMessage, sseMessages } from './sse'

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseMessage[]> {
  const messages: SseMessage[] = []
  for await (const message of sseMessages(body)) messages.push(message)
  return messages
}

describe('sseMessages', () => {
  it('reads named events with their data', async () => {
    const body = streamOf('event: ready\ndata: {}\n\nevent: receipt\ndata: {"id":"a"}\n\n')
    expect(await collect(body)).toEqual([
      { event: 'ready', data: '{}' },
      { event: 'receipt', data: '{"id":"a"}' },
    ])
  })

  it('joins an event split across chunks, even inside a multi-byte character', async () => {
    const bytes = new TextEncoder().encode('event: receipt\ndata: {"work":"/café"}\n\n')
    const cut = bytes.indexOf(0xc3) + 1
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 9))
        controller.enqueue(bytes.slice(9, cut))
        controller.enqueue(bytes.slice(cut))
        controller.close()
      },
    })
    expect(await collect(body)).toEqual([{ event: 'receipt', data: '{"work":"/café"}' }])
  })

  it('skips heartbeats and takes CRLF line ends', async () => {
    const body = streamOf(': ping\n\n', 'event: resync\r', '\ndata: {}\r\n\r\n', ': ping\n\n')
    expect(await collect(body)).toEqual([{ event: 'resync', data: '{}' }])
  })

  it('joins data lines with a newline and names an unnamed event "message"', async () => {
    const body = streamOf('data: one\ndata:two\n\n')
    expect(await collect(body)).toEqual([{ event: 'message', data: 'one\ntwo' }])
  })

  it('drops an event the stream ended in the middle of', async () => {
    const body = streamOf('event: ready\ndata: {}\n\nevent: receipt\ndata: {"id"')
    expect(await collect(body)).toEqual([{ event: 'ready', data: '{}' }])
  })
})

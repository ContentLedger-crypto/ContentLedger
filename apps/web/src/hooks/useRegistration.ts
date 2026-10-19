import type { RegistrationRequest } from '@contentledger/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RegistrationSource } from '@/lib/api'
import { type RegistrationStep, register, type TransactionSender } from '@/lib/register'

export interface Registration {
  readonly kind: RegistrationRequest['kind']
  readonly step: RegistrationStep
}

/**
 * One registration at a time. Leaving the screen stops the asking, not the transaction:
 * the domain list shows whether it landed.
 */
export function useRegistration({
  source,
  send,
  chain,
  onRegistered,
  onUnauthorized,
}: {
  source: RegistrationSource
  send: TransactionSender | null
  chain: string
  onRegistered: () => void
  onUnauthorized: (() => void) | undefined
}) {
  const [current, setCurrent] = useState<Registration | null>(null)
  const controller = useRef<AbortController | null>(null)
  const callbacks = useRef({ onRegistered, onUnauthorized })
  callbacks.current = { onRegistered, onUnauthorized }

  useEffect(() => () => controller.current?.abort(), [])

  const start = useCallback(
    (request: RegistrationRequest) => {
      if (send === null) return
      controller.current?.abort()
      const running = new AbortController()
      controller.current = running
      void register(
        request,
        { source, send, chain },
        {
          step: (step) => {
            if (running.signal.aborted) return
            setCurrent({ kind: request.kind, step })
            if (step.phase === 'registered') callbacks.current.onRegistered()
          },
          unauthorized: () => callbacks.current.onUnauthorized?.(),
        },
        running.signal,
      )
    },
    [source, send, chain],
  )

  const busy =
    current !== null && current.step.phase !== 'registered' && current.step.phase !== 'stopped'
  return { current, busy, start }
}

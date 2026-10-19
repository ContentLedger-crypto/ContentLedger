import type { PublisherDomains } from '@contentledger/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, type RegistrationSource } from '@/lib/api'

export type DomainsRead =
  | { readonly status: 'reading' }
  | { readonly status: 'read'; readonly domains: PublisherDomains['domains'] }
  | { readonly status: 'failed' }

/** The wallet's domains from the chain, read again on `reread` once a registration lands. */
export function useDomains(source: RegistrationSource, onUnauthorized: (() => void) | undefined) {
  const [read, setRead] = useState<DomainsRead>({ status: 'reading' })
  const [generation, setGeneration] = useState(0)
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is what asks for the read again.
  useEffect(() => {
    const controller = new AbortController()
    source.domains(controller.signal).then(
      ({ domains }) => {
        if (!controller.signal.aborted) setRead({ status: 'read', domains })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.status === 401) unauthorized.current?.()
        else setRead({ status: 'failed' })
      },
    )
    return () => controller.abort()
  }, [source, generation])

  const reread = useCallback(() => setGeneration((n) => n + 1), [])
  return { read, reread }
}

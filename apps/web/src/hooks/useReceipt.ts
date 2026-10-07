import { useEffect, useState } from 'react'
import type { PublicationSource } from '@/lib/api'
import { type ReceiptView, readReceipt } from '@/lib/receipt'

export type ReceiptRead =
  | { readonly status: 'reading' }
  | { readonly status: 'failed' }
  | { readonly status: 'read'; readonly view: ReceiptView }

export function useReceipt(source: PublicationSource, id: string): ReceiptRead {
  const [read, setRead] = useState<ReceiptRead>({ status: 'reading' })

  useEffect(() => {
    const controller = new AbortController()
    setRead({ status: 'reading' })
    readReceipt(source, id, controller.signal).then(
      (view) => {
        if (!controller.signal.aborted) setRead({ status: 'read', view })
      },
      () => {
        if (!controller.signal.aborted) setRead({ status: 'failed' })
      },
    )
    return () => controller.abort()
  }, [source, id])

  return read
}

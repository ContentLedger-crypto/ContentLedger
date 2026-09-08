import { useEffect, useState } from 'react'

/**
 * True below 768px. Used to swap the map geometry and to stack table rows.
 * No network, no observers beyond a media query.
 */
export function useIsNarrow(breakpoint = 768): boolean {
  const [narrow, setNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(`(max-width: ${breakpoint - 1}px)`).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches)
    setNarrow(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [breakpoint])

  return narrow
}

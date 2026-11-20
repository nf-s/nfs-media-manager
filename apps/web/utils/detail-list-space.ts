/** Space from a detail list to the bottom of its drawer or standalone page. */
export function observeDetailListSpace(
  element: HTMLElement,
  onHeight: (height: number) => void,
) {
  const frame = element.closest<HTMLElement>('.inspector-scroll, .app-main')
  if (!frame) return

  const parents: HTMLElement[] = []
  for (let box = element.parentElement; box; box = box.parentElement) {
    parents.push(box)
    if (box === frame) break
  }
  let lastHeight: number | undefined
  const measure = () => {
    // Use the list's unscrolled position. Scrolling to another section must
    // not grow the list above it or change a restored scroll position.
    const listTop = element.getBoundingClientRect().top + frame.scrollTop
    const frameBottom =
      frame.getBoundingClientRect().top + frame.clientTop + frame.clientHeight
    const padding = parents.reduce(
      (sum, box) => sum + parseFloat(getComputedStyle(box).paddingBottom),
      0,
    )
    const height = Math.max(0, Math.floor(frameBottom - listTop - padding))
    if (height !== lastHeight) {
      lastHeight = height
      onHeight(height)
    }
  }
  measure()
  if (typeof ResizeObserver === 'undefined') return

  let pending = 0
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(pending)
    pending = requestAnimationFrame(measure)
  })
  // Header text, filters and controls above the list can wrap or load later.
  for (const box of [element, ...parents]) {
    observer.observe(box)
    if (box === frame) break
    for (
      let sibling = box.previousElementSibling;
      sibling;
      sibling = sibling.previousElementSibling
    ) {
      observer.observe(sibling)
    }
  }
  return () => {
    observer.disconnect()
    cancelAnimationFrame(pending)
  }
}

/** Let a virtual list grow into spare room while retaining its short-screen cap. */
export function fitDetailList(element: HTMLElement) {
  const stop = observeDetailListSpace(element, (height) => {
    element.style.setProperty('--detail-list-space', `${height}px`)
  })
  return () => {
    stop?.()
    element.style.removeProperty('--detail-list-space')
  }
}

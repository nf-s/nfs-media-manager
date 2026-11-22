import { describe, expect, it } from 'vitest'
import { defaultPreviewPorts as webDefaultPreviewPorts } from '../../../web/e2e/preview-ports'
import { defaultPreviewPorts } from './preview-ports'

describe('defaultPreviewPorts', () => {
  it('gives a checkout the same pair every time, inside the preview ranges', () => {
    const ports = defaultPreviewPorts('/work/checkout')
    expect(defaultPreviewPorts('/work/checkout/')).toEqual(ports)
    expect(ports.web).toBeGreaterThanOrEqual(3710)
    expect(ports.web).toBeLessThan(3810)
    expect(ports.api - ports.web).toBe(1000)
  })

  it('spreads worktrees over different ports', () => {
    const webPorts = new Set(
      Array.from(
        { length: 20 },
        (_, index) => defaultPreviewPorts(`/work/worktree-${index}`).web,
      ),
    )
    expect(webPorts.size).toBeGreaterThan(10)
  })
  it('matches the copy the browser tests use', () => {
    for (const path of ['/work/checkout', '/work/worktree-1', '/other/place'])
      expect(webDefaultPreviewPorts(path)).toEqual(defaultPreviewPorts(path))
  })
})

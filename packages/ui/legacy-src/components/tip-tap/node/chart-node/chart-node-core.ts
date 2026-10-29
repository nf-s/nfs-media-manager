import type { ChartConfiguration } from '@repo/plot/types'
import { mergeAttributes, Node, type NodeType } from '@tiptap/react'

export type ChartNodeAttributes = {
  chart: ChartConfiguration | null
  height: number | null
}

export type ChartNodeCoreOptions = {
  type?: string | NodeType
  getDefaultAttributes: () => ChartNodeAttributes
  HTMLAttributes: Record<string, unknown>
}

export const getDefaultChartNodeAttributes = (): ChartNodeAttributes => ({
  chart: null,
  height: null,
})

export const chartNodeCoreExtension = Node.create<ChartNodeCoreOptions>({
  name: 'chart',

  group: 'block',

  atom: true,

  draggable: true,

  selectable: true,

  isolating: true,

  defining: true,

  addOptions() {
    return {
      type: 'chart',
      getDefaultAttributes: getDefaultChartNodeAttributes,
      HTMLAttributes: {},
    }
  },

  addAttributes() {
    return {
      chart: {
        default: this.options.getDefaultAttributes().chart,
      },
      height: {
        default: this.options.getDefaultAttributes().height ?? null,
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="chart"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    const rest = Object.fromEntries(
      Object.entries(HTMLAttributes).filter(([key]) => key !== 'chart'),
    )
    return [
      'div',
      mergeAttributes({ 'data-type': 'chart' }, rest),
      ['div', { 'data-node-placeholder': 'chart' }],
    ]
  },
})

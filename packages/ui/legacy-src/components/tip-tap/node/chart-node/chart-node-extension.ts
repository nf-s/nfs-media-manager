import {
  chartNodeCoreExtension,
  getDefaultChartNodeAttributes,
  type ChartNodeAttributes,
  type ChartNodeCoreOptions,
} from './chart-node-core'
import type { NodeType } from '@tiptap/pm/model'
import { ReactNodeViewRenderer } from '@tiptap/react'

import { ChartNodeView } from './chart-node'
import { ChartFormBuilder } from './chart-node-shared'

export type ChartNodeOptions = ChartNodeCoreOptions & {
  /**
   * Node type name used when serialising content.
   * @default 'chart'
   */
  type?: string | NodeType
  /**
   * Builder responsible for rendering charts and edit controls.
   */
  formBuilder?: ChartFormBuilder
}

declare module '@tiptap/react' {
  // eslint-disable-next-line no-unused-vars
  interface Commands<ReturnType> {
    chartNode: {
      /**
       * Inserts a new chart node at the current selection.
       */
      // eslint-disable-next-line no-unused-vars
      setChartNode: (_attrs?: Partial<ChartNodeAttributes>) => ReturnType
    }
  }
}

export const ChartNode = chartNodeCoreExtension.extend<ChartNodeOptions>({
  addOptions() {
    const parentOptions = this.parent?.()
    return {
      ...parentOptions,
      HTMLAttributes: parentOptions?.HTMLAttributes ?? {},
      getDefaultAttributes: getDefaultChartNodeAttributes,
      formBuilder: undefined,
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChartNodeView)
  },

  addCommands() {
    return {
      setChartNode:
        (partialAttrs: Partial<ChartNodeAttributes> = {}) =>
        ({ chain }) => {
          const defaultAttrs = this.options.getDefaultAttributes()
          const hasChart = Object.prototype.hasOwnProperty.call(
            partialAttrs,
            'chart',
          )
          const dataSource =
            hasChart && partialAttrs.chart !== undefined
              ? partialAttrs.chart
              : defaultAttrs.chart

          const mergedAttrs: ChartNodeAttributes = {
            chart: dataSource,
            height: partialAttrs.height ?? defaultAttrs.height ?? null,
          }

          return chain()
            .focus()
            .insertContent({
              type: this.name,
              attrs: mergedAttrs,
            })
            .run()
        },
    }
  },
})

export default ChartNode

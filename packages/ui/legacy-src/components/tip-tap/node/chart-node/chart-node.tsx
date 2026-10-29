import { ChartConfiguration } from '@repo/plot/types'
import type { NodeViewProps } from '@tiptap/react'
import { NodeViewWrapper } from '@tiptap/react'
import * as React from 'react'
import {
  ChartEditorHookParams,
  ChartFormBuilder,
  ChartNodeAttributes,
} from './chart-node-shared'
import './chart-node.scss'

const getChartTitle = (chart: ChartConfiguration | null) => {
  if (!chart) return 'Chart'
  if ('title' in chart && chart.title) {
    return chart.title
  }

  return 'Chart'
}

const getChartDescription = (chart: ChartConfiguration | null) => {
  if (!chart) return ''
  if ('description' in chart && chart.description) {
    return chart.description
  }

  return ''
}

function useNoopChartEditor(_params: ChartEditorHookParams) {
  return { controls: null }
}

const MIN_CHART_HEIGHT = 120
const DEFAULT_CHART_HEIGHT = 384

export function ChartNodeView(props: NodeViewProps) {
  const { node, updateAttributes, extension, editor } = props
  const attrs = node.attrs as ChartNodeAttributes
  const chart = attrs.chart ?? null
  const persistedHeight = attrs.height ?? null

  const builder = extension.options?.formBuilder as ChartFormBuilder | undefined

  const handleChartChange = React.useCallback(
    (nextChart: ChartConfiguration | null) => {
      updateAttributes({
        chart: nextChart,
      })
    },
    [updateAttributes],
  )

  const useChartEditorHook =
    builder?.useChartEditor !== undefined
      ? builder.useChartEditor
      : useNoopChartEditor

  const { controls: editorControls } = useChartEditorHook({
    chart,
    onChartChange: handleChartChange,
  })

  const renderedChart = React.useMemo(() => {
    if (!builder) return null
    return builder.renderChart(chart)
  }, [builder, chart])

  const chartTitle = getChartTitle(chart)
  const chartDescription = getChartDescription(chart)

  // -------------------------------------------------------------------------
  // Resize handle logic
  // -------------------------------------------------------------------------
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const [liveHeight, setLiveHeight] = React.useState<number | null>(null)

  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()

      const body = bodyRef.current
      if (!body) return

      const startY = e.clientY
      const startHeight = body.getBoundingClientRect().height

      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientY - startY
        const next = Math.max(MIN_CHART_HEIGHT, Math.round(startHeight + delta))
        setLiveHeight(next)
      }

      const onPointerUp = () => {
        document.removeEventListener('pointermove', onPointerMove)
        document.removeEventListener('pointerup', onPointerUp)

        // Persist the final height to the node attributes
        const currentBody = bodyRef.current
        if (currentBody) {
          const finalHeight = Math.max(
            MIN_CHART_HEIGHT,
            Math.round(currentBody.getBoundingClientRect().height),
          )
          updateAttributes({ height: finalHeight })
        }
        setLiveHeight(null)
      }

      document.addEventListener('pointermove', onPointerMove)
      document.addEventListener('pointerup', onPointerUp)
    },
    [updateAttributes],
  )

  // Height resolution: live drag height → persisted height → default
  const resolvedHeight = liveHeight ?? persistedHeight ?? DEFAULT_CHART_HEIGHT

  const isEditable = editor.isEditable

  return (
    <NodeViewWrapper className="tiptap-chart-node">
      <div className="tiptap-chart-node__header">
        <div className="tiptap-chart-node__header-text">
          <h3 className="tiptap-chart-node__title">{chartTitle}</h3>
          {chartDescription && (
            <div className="tiptap-chart-node__description">
              {chartDescription}
            </div>
          )}
        </div>
        {editorControls && (
          <div className="tiptap-chart-node__actions">{editorControls}</div>
        )}
      </div>
      <div
        ref={bodyRef}
        className="tiptap-chart-node__body"
        style={{ height: resolvedHeight }}
      >
        {renderedChart ?? (
          <div className="tiptap-chart-node__empty">
            Chart builder not available. Configure chart support in the host
            application.
          </div>
        )}
      </div>
      {isEditable && (
        <div
          className="tiptap-chart-node__resize-handle"
          onPointerDown={handlePointerDown}
          title="Drag to resize chart height"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              d="M9 1L1 9M9 5L5 9M9 9L9 9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
      )}
    </NodeViewWrapper>
  )
}

ChartNodeView.displayName = 'ChartNodeView'

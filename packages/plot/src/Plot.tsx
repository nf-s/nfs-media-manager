import * as ObservablePlot from '@observablehq/plot'
import { useEffect, useRef } from 'react'
import { OnSelectCallback } from './types'

/**
 * Observable Plot example component.
 *
 * This is a simplified Observable Plot integration kept as a reference for
 * future custom Observable-based visualisations. For standard chart types
 * (line, area, bar, scatter, donut) use the Recharts-based `PlotChart`
 * component from `@repo/ui` instead.
 */

interface BasePlotRecord {
  id: string
  value: number
}

interface ObservablePlotProps<T extends BasePlotRecord> {
  data: T[]
  x: string
  y: string
  xLabel?: string
  yLabel?: string
  groupBy: string
  onSelect?: OnSelectCallback<T>
}

export const DEFAULT_CHART_DATA_PROPS: ObservablePlotProps<{
  id: string
  value: number
  timePoint: string
}> = {
  x: 'timePoint',
  y: 'value',
  groupBy: 'indicatorName',
  data: [
    {
      id: 'sample-1',
      timePoint: '2024-01-01T00:00:00Z',
      value: 24,
    },
    {
      id: 'sample-2',
      timePoint: '2024-01-08T00:00:00Z',
      value: 32,
    },
    {
      id: 'sample-3',
      timePoint: '2024-01-15T00:00:00Z',
      value: 18,
    },
    {
      id: 'sample-4',
      timePoint: '2024-01-22T00:00:00Z',
      value: 41,
    },
  ],
}

export function getPlotCodeSnippet<T extends { id: string; value: number }>({
  data,
  x,
  y,
}: {
  data: T[]
  x: string
  y: string
}) {
  const params = {
    x,
    y,
    data,
  }

  return [
    `csdr = (${JSON.stringify(params)})`,
    `Plot.plot({
  margin: 50,
  style: {
    background: 'transparent',
  },
  y: {
    grid: true,
  },
  color: {
    type: 'diverging',
    scheme: 'burd',
  },
  marks: [
    Plot.dot(csdr.data, Plot.pointer({ x: csdr.x, y: csdr.y, fill: 'red', r: 8 })),
    Plot.ruleY([0]),
    Plot.line(csdr.data, { x: csdr.x, y: csdr.y }),
  ],
})`,
  ]
}

/**
 * Renders data as a line chart using Observable Plot.
 *
 * This is an example / reference implementation. Use the Recharts-based
 * `PlotChart` component for standard charting in reports and dashboards.
 */
export function Plot<T extends BasePlotRecord>({
  data,
  x,
  y,
  xLabel,
  yLabel,
  groupBy,
  onSelect,
}: ObservablePlotProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const marks: ObservablePlot.Markish[] = [
      ObservablePlot.ruleY([0]),
      ObservablePlot.line(data, { x, y, stroke: groupBy, strokeWidth: 2 }),
      ObservablePlot.dot(
        data,
        ObservablePlot.pointer({ x, y, fill: groupBy, r: 6 }),
      ),
    ]

    const chart = ObservablePlot.plot({
      margin: 50,
      style: {
        background: 'transparent',
        fontSize: '16px',
      },
      y: {
        grid: true,
        label: yLabel,
      },
      x: {
        label: xLabel,
      },
      color: { legend: true },
      marks,
    })
    containerRef.current?.append(chart)

    chart.addEventListener('click', (event) => {
      if (event instanceof MouseEvent) {
        event.stopPropagation()
        event.preventDefault()
        if (chart.value) {
          onSelect?.({ dataPoint: chart.value, event })
        } else {
          onSelect?.({ dataPoint: null, event })
        }
      }
    })

    return () => chart.remove()
  }, [data, groupBy, onSelect, x, xLabel, y, yLabel])

  return <div ref={containerRef} className="w-full h-full"></div>
}

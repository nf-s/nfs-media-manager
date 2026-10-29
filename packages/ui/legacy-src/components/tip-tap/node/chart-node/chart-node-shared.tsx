import type { ChartConfiguration, OnSelectCallback } from '@repo/plot/types'
import type { ReactNode } from 'react'
import type { ChartNodeAttributes } from './chart-node-core'

export type { ChartNodeAttributes } from './chart-node-core'

/* eslint-disable @typescript-eslint/no-unused-vars, no-unused-vars */
export type ChartEditorHookParams = {
  chart: ChartConfiguration | null
  onChartChange: (nextChart: ChartConfiguration | null) => void
}

export type ChartEditorHookResult = {
  controls: ReactNode
}

export type ChartFormBuilder = {
  renderChart: (chartConfiguration: ChartConfiguration | null) => ReactNode
  useChartEditor: (
    chartEditorParams: ChartEditorHookParams,
  ) => ChartEditorHookResult
}

import { z } from '@hono/zod-openapi'

export const categoricalColorSchemeValues = [
  'tableau10',
  'category10',
  'paired',
  'set1',
  'set2',
  'set3',
  'dark2',
  'accent',
  'observable10',
] as const

export const sequentialColorSchemeValues = [
  'ylOrRd',
  'viridis',
  'plasma',
  'inferno',
  'blues',
  'greens',
  'oranges',
  'ylGnBu',
  'buPu',
] as const

export const divergingColorSchemeValues = [
  'rdBu',
  'brBG',
  'piYG',
  'prGn',
  'rdYlGn',
] as const

export const curveTypeValues = ['monotone', 'linear', 'step'] as const
export const legendPositionValues = ['top', 'bottom', 'none'] as const
export const datePrecisionValues = [
  'year',
  'year-month',
  'year-month-day',
  'full',
] as const
export const plotSubTypeValues = [
  'line',
  'area',
  'stacked-area',
  'stacked-bar',
  'grouped-bar',
  'ranked-bar',
  'dot',
  'donut',
] as const
export const tableChartDimensionValues = [
  'timePoint',
  'indicatorName',
  'geometryOutputName',
] as const

export type CategoricalColorScheme =
  (typeof categoricalColorSchemeValues)[number]
export type SequentialColorScheme = (typeof sequentialColorSchemeValues)[number]
export type DivergingColorScheme = (typeof divergingColorSchemeValues)[number]
export type CurveType = (typeof curveTypeValues)[number]
export type LegendPosition = (typeof legendPositionValues)[number]
export type DatePrecision = (typeof datePrecisionValues)[number]
export type PlotSubType = (typeof plotSubTypeValues)[number]
export type TableChartDimension = (typeof tableChartDimensionValues)[number]

export type AppearanceConfig = {
  categoricalScheme?: CategoricalColorScheme
  colorOverrides?: Record<string, string>
  sequentialScheme?: SequentialColorScheme
  divergingScheme?: DivergingColorScheme
  colorScaleType?: 'sequential' | 'diverging'
  divergingMidpoint?: number
  colorScaleMin?: number
  colorScaleMax?: number
  reverseColorScale?: boolean
  includeZero?: boolean
  yMin?: number
  yMax?: number
  legendPosition?: LegendPosition
  showGrid?: boolean
  curveType?: CurveType
  showDots?: boolean
  areaOpacity?: number
  barRadius?: number
  donutInnerRadius?: number
  showOutlines?: boolean
  mapBbox?: {
    minLon: number
    minLat: number
    maxLon: number
    maxLat: number
  }
  decimalPlaces?: number
  compactNumbers?: boolean
  datePrecision?: DatePrecision
}

export type BaseChartConfiguration = {
  productRunId: string
  title?: string
  description?: string
  appearance?: AppearanceConfig
}

export type PlotChartConfiguration = BaseChartConfiguration & {
  type: 'plot'
  subType: PlotSubType
  indicatorIds: string[]
  geometryOutputIds?: string[]
  timePoints?: string[]
}

export type MapChartConfiguration = BaseChartConfiguration & {
  type: 'map'
  indicatorId: string
  timePoint: string
  geometryOutputIds?: string[]
}

export type TableChartConfiguration = BaseChartConfiguration & {
  type: 'table'
  indicatorIds: string[]
  geometryOutputIds?: string[]
  xDimension: TableChartDimension
  yDimension: TableChartDimension
  timePoints?: string[]
}

export type KpiChartConfiguration = BaseChartConfiguration & {
  type: 'kpi'
  indicatorId: string
  timePoint: string
  geometryOutputIds: string[]
}

export type ChartConfiguration =
  | PlotChartConfiguration
  | MapChartConfiguration
  | TableChartConfiguration
  | KpiChartConfiguration

export type ChartIndicatorSelection = {
  productRunId: string
  indicatorIds: string[]
}

export const chartVisualTypeMetadata = [
  {
    key: 'line',
    type: 'plot',
    subType: 'line',
    label: 'Line',
    description: 'Trends over time',
  },
  {
    key: 'area',
    type: 'plot',
    subType: 'area',
    label: 'Area',
    description: 'Filled trends',
  },
  {
    key: 'stacked-area',
    type: 'plot',
    subType: 'stacked-area',
    label: 'Stacked Area',
    description: 'Part-to-whole over time',
  },
  {
    key: 'stacked-bar',
    type: 'plot',
    subType: 'stacked-bar',
    label: 'Stacked Bar',
    description: 'Totals by category',
  },
  {
    key: 'grouped-bar',
    type: 'plot',
    subType: 'grouped-bar',
    label: 'Grouped Bar',
    description: 'Side-by-side comparison',
  },
  {
    key: 'ranked-bar',
    type: 'plot',
    subType: 'ranked-bar',
    label: 'Ranked Bar',
    description: 'Sorted horizontal bars',
  },
  {
    key: 'dot',
    type: 'plot',
    subType: 'dot',
    label: 'Scatter',
    description: 'Value distribution',
  },
  {
    key: 'donut',
    type: 'plot',
    subType: 'donut',
    label: 'Donut',
    description: 'Proportions',
  },
  {
    key: 'table',
    type: 'table',
    label: 'Table',
    description: 'Colour-coded grid',
  },
  {
    key: 'map',
    type: 'map',
    label: 'Map',
    description: 'Spatial view',
  },
  {
    key: 'kpi',
    type: 'kpi',
    label: 'KPI Card',
    description: 'Single highlighted value',
  },
] as const

export const tableChartDimensionMetadata = [
  { value: 'timePoint', label: 'Time' },
  { value: 'indicatorName', label: 'Indicator' },
  { value: 'geometryOutputName', label: 'Geometry' },
] as const satisfies readonly {
  value: TableChartDimension
  label: string
}[]

const MAX_CLASSES = 100

const appearanceConfigShape = {
  categoricalScheme: z.enum(categoricalColorSchemeValues).optional().openapi({
    description: 'Categorical colour palette used for plot series.',
  }),
  colorOverrides: z.record(z.string(), z.string()).optional().openapi({
    description: 'Per-series colour overrides keyed by rendered series label.',
  }),
  sequentialScheme: z.enum(sequentialColorSchemeValues).optional().openapi({
    description: 'Sequential colour palette used for table and map scales.',
  }),
  divergingScheme: z.enum(divergingColorSchemeValues).optional().openapi({
    description: 'Diverging colour palette used for table and map scales.',
  }),
  colorScaleType: z.enum(['sequential', 'diverging']).optional(),
  divergingMidpoint: z.number().optional(),
  colorScaleMin: z.number().optional(),
  colorScaleMax: z.number().optional(),
  reverseColorScale: z.boolean().optional(),
  includeZero: z.boolean().optional(),
  yMin: z.number().optional(),
  yMax: z.number().optional(),
  legendPosition: z.enum(legendPositionValues).optional(),
  showGrid: z.boolean().optional(),
  curveType: z.enum(curveTypeValues).optional(),
  showDots: z.boolean().optional(),
  areaOpacity: z.number().min(0).max(1).optional(),
  barRadius: z.number().min(0).max(20).optional(),
  donutInnerRadius: z.number().min(0).max(100).optional(),
  showOutlines: z.boolean().optional(),
  mapBbox: z
    .object({
      minLon: z.number().min(-360).max(360),
      minLat: z.number().min(-90).max(90),
      maxLon: z.number().min(-360).max(360),
      maxLat: z.number().min(-90).max(90),
    })
    .optional(),
  decimalPlaces: z.number().int().min(0).max(6).optional(),
  compactNumbers: z.boolean().optional(),
  datePrecision: z.enum(datePrecisionValues).optional(),
} satisfies z.ZodRawShape

export const appearanceConfigSchema = z
  .object(appearanceConfigShape)
  .openapi('ChartAppearanceSchema', {
    description: 'Presentation settings shared across persisted chart types.',
  }) satisfies z.ZodType<AppearanceConfig>

export const baseChartConfigurationSchema = z
  .object({
    productRunId: z.string().openapi({
      description: 'Product run providing the chart data.',
    }),
    title: z.string().optional().openapi({
      description: 'Optional chart title shown in reports and dashboards.',
    }),
    description: z.string().optional().openapi({
      description: 'Optional chart description shown under the title.',
    }),
    appearance: appearanceConfigSchema.optional(),
  })
  .openapi(
    'BaseChartConfigurationSchema',
  ) satisfies z.ZodType<BaseChartConfiguration>

const multiSeriesSelectionSchema = baseChartConfigurationSchema.extend({
  indicatorIds: z
    .array(z.string())
    .max(MAX_CLASSES, `At most ${MAX_CLASSES} indicators can be selected`)
    .min(1, 'At least one indicator must be selected'),
  geometryOutputIds: z
    .array(z.string())
    .max(MAX_CLASSES, `At most ${MAX_CLASSES} geometry outputs can be selected`)
    .optional(),
  timePoints: z.array(z.string()).optional(),
})

export const plotChartConfigurationSchema = multiSeriesSelectionSchema
  .extend({
    type: z.literal('plot'),
    subType: z.enum(plotSubTypeValues).openapi({
      description: 'Specific plot variant to render.',
    }),
  })
  .superRefine((data, context) => {
    const multipleIndicatorsSelected = data.indicatorIds.length > 1
    const multipleGeometryOutputsSelected =
      (data.geometryOutputIds?.length ?? 0) > 1 ||
      !data.geometryOutputIds?.length
    const multipleTimePointsSelected =
      (data.timePoints?.length ?? 0) > 1 || !data.timePoints?.length

    if (data.subType === 'donut' || data.subType === 'ranked-bar') {
      const chartLabel =
        data.subType === 'donut' ? 'Donut chart' : 'Ranked bar chart'
      const multipleCount =
        (multipleIndicatorsSelected ? 1 : 0) +
        (multipleGeometryOutputsSelected ? 1 : 0) +
        (multipleTimePointsSelected ? 1 : 0)

      if (multipleCount > 1) {
        if (multipleIndicatorsSelected) {
          context.addIssue({
            code: 'custom',
            message: `${chartLabel} can only vary one dimension — select a single indicator`,
            path: ['indicatorIds'],
            input: data.indicatorIds,
          })
        }
        if (multipleGeometryOutputsSelected) {
          context.addIssue({
            code: 'custom',
            message: `${chartLabel} can only vary one dimension — select a single geometry`,
            path: ['geometryOutputIds'],
            input: data.geometryOutputIds,
          })
        }
        if (multipleTimePointsSelected) {
          context.addIssue({
            code: 'custom',
            message: `${chartLabel} can only vary one dimension — select a single time point`,
            path: ['timePoints'],
            input: data.timePoints,
          })
        }
      }
      return
    }

    const multiCount =
      (multipleIndicatorsSelected ? 1 : 0) +
      (multipleGeometryOutputsSelected ? 1 : 0) +
      (multipleTimePointsSelected ? 1 : 0)

    if (multiCount > 2) {
      context.addIssue({
        code: 'custom',
        message:
          'Each chart element must map to one product output — select a single indicator',
        path: ['indicatorIds'],
        input: data.indicatorIds,
      })
      context.addIssue({
        code: 'custom',
        message:
          'Each chart element must map to one product output — select a single geometry',
        path: ['geometryOutputIds'],
        input: data.geometryOutputIds,
      })
      context.addIssue({
        code: 'custom',
        message:
          'Each chart element must map to one product output — select a single time point',
        path: ['timePoints'],
        input: data.timePoints,
      })
    } else if (multipleIndicatorsSelected && multipleGeometryOutputsSelected) {
      context.addIssue({
        code: 'custom',
        message:
          'Each chart element must map to one product output — select a single indicator or a single geometry',
        path: ['indicatorIds'],
        input: data.indicatorIds,
      })
      context.addIssue({
        code: 'custom',
        message:
          'Each chart element must map to one product output — select a single indicator or a single geometry',
        path: ['geometryOutputIds'],
        input: data.geometryOutputIds,
      })
    }
  })
  .openapi('PlotChartConfigurationSchema', {
    description:
      'Cartesian and single-dimension plot charts. Validation messages explain when multiple selections are not compatible with the selected plot subtype.',
  }) satisfies z.ZodType<PlotChartConfiguration>

export const mapChartConfigurationSchema = baseChartConfigurationSchema
  .extend({
    type: z.literal('map'),
    indicatorId: z.string().openapi({
      description: 'Map charts require exactly one indicator selection.',
    }),
    timePoint: z.string().openapi({
      description: 'Map charts require exactly one time point selection.',
    }),
    geometryOutputIds: z
      .array(z.string())
      .max(10, 'At most 10 geometry outputs can be selected')
      .optional()
      .openapi({
        description:
          'Optional geometry filter for zooming or limiting the map view.',
      }),
  })
  .openapi('MapChartConfigurationSchema', {
    description:
      'Spatial map view for a single indicator at a single time point.',
  }) satisfies z.ZodType<MapChartConfiguration>

export const kpiChartConfigurationSchema = baseChartConfigurationSchema
  .extend({
    type: z.literal('kpi'),
    indicatorId: z.string().openapi({
      description: 'KPI cards require exactly one indicator selection.',
    }),
    timePoint: z.string().openapi({
      description: 'KPI cards require exactly one time point selection.',
    }),
    geometryOutputIds: z
      .array(z.string())
      .min(1, 'KPI requires a selected geometry')
      .max(1, 'KPI requires exactly one geometry')
      .openapi({
        description: 'KPI cards require exactly one selected geometry output.',
      }),
  })
  .openapi('KpiChartConfigurationSchema', {
    description:
      'Single highlighted value for one indicator, geometry, and time point.',
  }) satisfies z.ZodType<KpiChartConfiguration>

export const tableChartConfigurationSchema = multiSeriesSelectionSchema
  .extend({
    type: z.literal('table'),
    xDimension: z.enum(tableChartDimensionValues),
    yDimension: z.enum(tableChartDimensionValues),
  })
  .superRefine((data, context) => {
    const multipleIndicatorsSelected = data.indicatorIds.length > 1
    const multipleGeometryOutputsSelected =
      (data.geometryOutputIds?.length ?? 0) > 1 ||
      !data.geometryOutputIds?.length
    const multipleTimePointsSelected =
      (data.timePoints?.length ?? 0) > 1 || !data.timePoints?.length

    const allowsMultipleIndicators =
      data.xDimension === 'indicatorName' || data.yDimension === 'indicatorName'
    if (!allowsMultipleIndicators && multipleIndicatorsSelected) {
      context.addIssue({
        code: 'custom',
        message: 'Indicator is not used as a table axis, one must be selected.',
        path: ['indicatorIds'],
        input: data.indicatorIds,
      })
    }

    const allowsMultipleGeometry =
      data.xDimension === 'geometryOutputName' ||
      data.yDimension === 'geometryOutputName'
    if (!allowsMultipleGeometry && multipleGeometryOutputsSelected) {
      context.addIssue({
        code: 'custom',
        message:
          'Geometry output is not used as a table axis, one must be selected.',
        path: ['geometryOutputIds'],
        input: data.geometryOutputIds,
      })
    }

    const allowsMultipleTimePoints =
      data.xDimension === 'timePoint' || data.yDimension === 'timePoint'
    if (!allowsMultipleTimePoints && multipleTimePointsSelected) {
      context.addIssue({
        code: 'custom',
        message:
          'Time point is not used as a table axis, one must be selected.',
        path: ['timePoints'],
        input: data.timePoints,
      })
    }
  })
  .openapi('TableChartConfigurationSchema', {
    description:
      'Colour-coded table view. Dimensions not placed on an axis must be narrowed to a single selection.',
  }) satisfies z.ZodType<TableChartConfiguration>

export const chartConfigurationSchema = z
  .discriminatedUnion('type', [
    plotChartConfigurationSchema,
    mapChartConfigurationSchema,
    kpiChartConfigurationSchema,
    tableChartConfigurationSchema,
  ])
  .openapi('ChartConfigurationSchema', {
    description:
      'Persisted chart configuration used by report chart nodes and dashboard cards.',
  }) satisfies z.ZodType<ChartConfiguration>

const dedupeIndicatorIds = (indicatorIds: string[]): string[] =>
  Array.from(new Set(indicatorIds))

export const extractChartIndicatorSelection = (
  chart: ChartConfiguration,
): ChartIndicatorSelection => {
  switch (chart.type) {
    case 'plot':
    case 'table':
      return {
        productRunId: chart.productRunId,
        indicatorIds: dedupeIndicatorIds(chart.indicatorIds),
      }
    case 'map':
    case 'kpi':
      return {
        productRunId: chart.productRunId,
        indicatorIds: [chart.indicatorId],
      }
    default: {
      const exhaustiveCheck: never = chart
      throw new Error(`Unhandled chart type: ${String(exhaustiveCheck)}`)
    }
  }
}

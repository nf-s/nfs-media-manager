import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'
import {
  chartConfigurationSchema,
  extractChartIndicatorSelection,
} from '../legacy-src/chart'
import {
  dashboardQuerySchema,
  dashboardContentSchema,
  fullDatasetRunSchema,
  fullMeasuredIndicatorSchema,
  fullProductSchema,
  fullDashboardSchema,
  fullReportSchema,
  reportQuerySchema,
  reportStoredContentSchema,
} from '../legacy-src/crud'
import {
  extractReportChartReferences,
  extractReportIndicatorSelections,
  extractReportProductRunIds,
  parseReportStoredContent,
  reportTiptapDocumentSchema,
} from '../legacy-src/report-content'

const basePlotSelections = {
  productRunId: 'run-1',
  indicatorIds: ['indicator-1'],
  geometryOutputIds: ['geometry-1'],
  timePoints: ['2024'],
}

const issuesFor = (
  result: ReturnType<typeof chartConfigurationSchema.safeParse>,
) => {
  if (result.success) {
    throw new Error('Expected schema parsing to fail')
  }

  return result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }))
}

describe('chartConfigurationSchema', () => {
  it.each([
    [
      'line',
      {
        type: 'plot',
        subType: 'line',
        ...basePlotSelections,
        timePoints: ['2024', '2025'],
      },
    ],
    [
      'area',
      {
        type: 'plot',
        subType: 'area',
        ...basePlotSelections,
        timePoints: ['2024', '2025'],
      },
    ],
    [
      'stacked-area',
      {
        type: 'plot',
        subType: 'stacked-area',
        ...basePlotSelections,
        indicatorIds: ['indicator-1', 'indicator-2'],
        timePoints: ['2024', '2025'],
      },
    ],
    [
      'stacked-bar',
      {
        type: 'plot',
        subType: 'stacked-bar',
        ...basePlotSelections,
        geometryOutputIds: ['geometry-1', 'geometry-2'],
        timePoints: ['2024', '2025'],
      },
    ],
    [
      'grouped-bar',
      {
        type: 'plot',
        subType: 'grouped-bar',
        ...basePlotSelections,
        indicatorIds: ['indicator-1', 'indicator-2'],
      },
    ],
    [
      'ranked-bar',
      {
        type: 'plot',
        subType: 'ranked-bar',
        ...basePlotSelections,
        geometryOutputIds: ['geometry-1', 'geometry-2'],
      },
    ],
    [
      'dot',
      {
        type: 'plot',
        subType: 'dot',
        ...basePlotSelections,
        timePoints: ['2024', '2025'],
      },
    ],
    [
      'donut',
      {
        type: 'plot',
        subType: 'donut',
        ...basePlotSelections,
        indicatorIds: ['indicator-1', 'indicator-2'],
      },
    ],
    [
      'map',
      {
        type: 'map',
        productRunId: 'run-1',
        indicatorId: 'indicator-1',
        timePoint: '2024',
        geometryOutputIds: ['geometry-1'],
      },
    ],
    [
      'table',
      {
        type: 'table',
        ...basePlotSelections,
        indicatorIds: ['indicator-1', 'indicator-2'],
        timePoints: ['2024', '2025'],
        xDimension: 'indicatorName',
        yDimension: 'timePoint',
      },
    ],
    [
      'kpi',
      {
        type: 'kpi',
        productRunId: 'run-1',
        indicatorId: 'indicator-1',
        timePoint: '2024',
        geometryOutputIds: ['geometry-1'],
      },
    ],
  ])('accepts %s chart configurations', (_label, chart) => {
    expect(chartConfigurationSchema.parse(chart)).toMatchObject(chart)
  })

  it('strips deprecated productId fields from persisted chart output', () => {
    const parsed = chartConfigurationSchema.parse({
      type: 'plot',
      subType: 'line',
      ...basePlotSelections,
      productId: 'legacy-product',
    })

    expect(parsed).not.toHaveProperty('productId')
  })

  it('returns exact donut validation issues', () => {
    const result = chartConfigurationSchema.safeParse({
      type: 'plot',
      subType: 'donut',
      ...basePlotSelections,
      indicatorIds: ['indicator-1', 'indicator-2'],
      timePoints: ['2024', '2025'],
    })

    expect(issuesFor(result)).toEqual([
      {
        path: 'indicatorIds',
        message:
          'Donut chart can only vary one dimension — select a single indicator',
      },
      {
        path: 'timePoints',
        message:
          'Donut chart can only vary one dimension — select a single time point',
      },
    ])
  })

  it('returns exact ranked bar validation issues', () => {
    const result = chartConfigurationSchema.safeParse({
      type: 'plot',
      subType: 'ranked-bar',
      ...basePlotSelections,
      geometryOutputIds: ['geometry-1', 'geometry-2'],
      timePoints: ['2024', '2025'],
    })

    expect(issuesFor(result)).toEqual([
      {
        path: 'geometryOutputIds',
        message:
          'Ranked bar chart can only vary one dimension — select a single geometry',
      },
      {
        path: 'timePoints',
        message:
          'Ranked bar chart can only vary one dimension — select a single time point',
      },
    ])
  })

  it('returns exact cartesian plot validation issues when every dimension varies', () => {
    const result = chartConfigurationSchema.safeParse({
      type: 'plot',
      subType: 'line',
      ...basePlotSelections,
      indicatorIds: ['indicator-1', 'indicator-2'],
      geometryOutputIds: ['geometry-1', 'geometry-2'],
      timePoints: ['2024', '2025'],
    })

    expect(issuesFor(result)).toEqual([
      {
        path: 'indicatorIds',
        message:
          'Each chart element must map to one product output — select a single indicator',
      },
      {
        path: 'geometryOutputIds',
        message:
          'Each chart element must map to one product output — select a single geometry',
      },
      {
        path: 'timePoints',
        message:
          'Each chart element must map to one product output — select a single time point',
      },
    ])
  })

  it('returns exact cartesian plot validation issues when both indicators and geometries vary', () => {
    const result = chartConfigurationSchema.safeParse({
      type: 'plot',
      subType: 'line',
      ...basePlotSelections,
      indicatorIds: ['indicator-1', 'indicator-2'],
      geometryOutputIds: ['geometry-1', 'geometry-2'],
    })

    expect(issuesFor(result)).toEqual([
      {
        path: 'indicatorIds',
        message:
          'Each chart element must map to one product output — select a single indicator or a single geometry',
      },
      {
        path: 'geometryOutputIds',
        message:
          'Each chart element must map to one product output — select a single indicator or a single geometry',
      },
    ])
  })

  it('returns exact table validation issues for non-axis indicator and geometry selections', () => {
    const result = chartConfigurationSchema.safeParse({
      type: 'table',
      ...basePlotSelections,
      indicatorIds: ['indicator-1', 'indicator-2'],
      geometryOutputIds: ['geometry-1', 'geometry-2'],
      timePoints: ['2024', '2025'],
      xDimension: 'timePoint',
      yDimension: 'indicatorName',
    })

    expect(issuesFor(result)).toEqual([
      {
        path: 'geometryOutputIds',
        message:
          'Geometry output is not used as a table axis, one must be selected.',
      },
    ])
  })

  it('returns exact table validation issues for a non-axis time selection', () => {
    const result = chartConfigurationSchema.safeParse({
      type: 'table',
      ...basePlotSelections,
      indicatorIds: ['indicator-1', 'indicator-2'],
      timePoints: ['2024', '2025'],
      xDimension: 'indicatorName',
      yDimension: 'geometryOutputName',
    })

    expect(issuesFor(result)).toEqual([
      {
        path: 'timePoints',
        message:
          'Time point is not used as a table axis, one must be selected.',
      },
    ])
  })

  it('returns exact KPI validation messages', () => {
    const missingGeometry = chartConfigurationSchema.safeParse({
      type: 'kpi',
      productRunId: 'run-1',
      indicatorId: 'indicator-1',
      timePoint: '2024',
      geometryOutputIds: [],
    })
    const tooManyGeometries = chartConfigurationSchema.safeParse({
      type: 'kpi',
      productRunId: 'run-1',
      indicatorId: 'indicator-1',
      timePoint: '2024',
      geometryOutputIds: ['geometry-1', 'geometry-2'],
    })

    expect(issuesFor(missingGeometry)).toEqual([
      {
        path: 'geometryOutputIds',
        message: 'KPI requires a selected geometry',
      },
    ])
    expect(issuesFor(tooManyGeometries)).toEqual([
      {
        path: 'geometryOutputIds',
        message: 'KPI requires exactly one geometry',
      },
    ])
  })
})

describe('crud schemas', () => {
  it('accepts usage counts on full detail schemas', () => {
    expect(
      fullMeasuredIndicatorSchema.parse({
        id: 'indicator-1',
        name: 'Forest cover',
        description: null,
        metadata: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        unit: '%',
        category: null,
        displayOrder: null,
        categoryId: null,
        type: 'measured',
        productCount: 1,
        reportCount: 2,
        dashboardCount: 3,
      }).reportCount,
    ).toBe(2)

    expect(
      fullProductSchema.parse({
        id: 'product-1',
        name: 'Forest model',
        description: null,
        metadata: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        timePrecision: 'year',
        mainRunId: null,
        dataset: null,
        geometries: null,
        mainRun: null,
        runCount: 1,
        reportCount: 4,
        dashboardCount: 5,
      }).dashboardCount,
    ).toBe(5)

    expect(
      fullDatasetRunSchema.parse({
        id: 'dataset-run-1',
        name: 'Dataset run',
        description: null,
        metadata: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        imageCode: null,
        imageTag: null,
        provenanceJson: null,
        provenanceUrl: null,
        dataUrl: null,
        dataType: null,
        dataSize: null,
        dataEtag: null,
        dataset: {
          id: 'dataset-1',
          name: 'Dataset',
          mainRunId: null,
        },
        productRunCount: 1,
        reportCount: 6,
        dashboardCount: 7,
      }).reportCount,
    ).toBe(6)
  })

  it('accepts expanded report and dashboard usage filters', () => {
    expect(
      reportQuerySchema.parse({
        indicatorId: ['indicator-1'],
        productId: ['product-1'],
        productRunId: 'product-run-1',
        datasetId: ['dataset-1'],
        datasetRunId: 'dataset-run-1',
        geometriesId: ['geometries-1'],
        geometriesRunId: 'geometries-run-1',
      }),
    ).toMatchObject({
      indicatorId: ['indicator-1'],
      productId: ['product-1'],
      productRunId: 'product-run-1',
      datasetId: ['dataset-1'],
      datasetRunId: 'dataset-run-1',
      geometriesId: ['geometries-1'],
      geometriesRunId: 'geometries-run-1',
    })

    expect(
      dashboardQuerySchema.parse({
        indicatorId: 'indicator-1',
        productId: 'product-1',
        productRunId: 'product-run-1',
        datasetId: 'dataset-1',
        datasetRunId: 'dataset-run-1',
        geometriesId: 'geometries-1',
        geometriesRunId: 'geometries-run-1',
      }),
    ).toMatchObject({
      indicatorId: 'indicator-1',
      productId: 'product-1',
      productRunId: 'product-run-1',
      datasetId: 'dataset-1',
      datasetRunId: 'dataset-run-1',
      geometriesId: 'geometries-1',
      geometriesRunId: 'geometries-run-1',
    })
  })
})

describe('extractChartIndicatorSelection', () => {
  it('returns explicit indicator selections for plot and table charts', () => {
    expect(
      extractChartIndicatorSelection({
        type: 'plot',
        subType: 'line',
        ...basePlotSelections,
        indicatorIds: ['indicator-1', 'indicator-2'],
      }),
    ).toEqual({
      productRunId: 'run-1',
      indicatorIds: ['indicator-1', 'indicator-2'],
    })

    expect(
      extractChartIndicatorSelection({
        type: 'table',
        ...basePlotSelections,
        indicatorIds: ['indicator-1'],
        xDimension: 'timePoint',
        yDimension: 'geometryOutputName',
      }),
    ).toEqual({
      productRunId: 'run-1',
      indicatorIds: ['indicator-1'],
    })
  })

  it('returns explicit indicator selections for single-indicator chart types', () => {
    expect(
      extractChartIndicatorSelection({
        type: 'map',
        productRunId: 'run-1',
        indicatorId: 'indicator-1',
        timePoint: '2024',
      }),
    ).toEqual({
      productRunId: 'run-1',
      indicatorIds: ['indicator-1'],
    })
  })
})

describe('explicit indicator requirements', () => {
  it('requires explicit indicatorIds for plot and table charts', () => {
    expect(
      chartConfigurationSchema.safeParse({
        type: 'plot',
        subType: 'line',
        productRunId: 'run-1',
        geometryOutputIds: ['geometry-1'],
        timePoints: ['2024'],
      }).success,
    ).toBe(false)

    expect(
      chartConfigurationSchema.safeParse({
        type: 'table',
        productRunId: 'run-1',
        xDimension: 'timePoint',
        yDimension: 'indicatorName',
        geometryOutputIds: ['geometry-1'],
        timePoints: ['2024'],
      }).success,
    ).toBe(false)
  })
})

describe('reportStoredContentSchema', () => {
  it('keeps the public report payload schema opaque', () => {
    expect(
      reportStoredContentSchema.parse({
        type: 'doc',
        content: [{ type: 'paragraph' }],
      }),
    ).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    })
  })
})

describe('reportTiptapDocumentSchema', () => {
  it('parses generic Tiptap content while typing chart nodes', () => {
    const parsed = parseReportStoredContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Overview' }],
        },
        {
          type: 'chart',
          attrs: {
            chart: {
              type: 'plot',
              subType: 'line',
              ...basePlotSelections,
              productId: 'legacy-product',
            },
            height: 360,
          },
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Nested chart' }],
                },
                {
                  type: 'chart',
                  attrs: {
                    chart: {
                      type: 'kpi',
                      productRunId: 'run-2',
                      indicatorId: 'indicator-2',
                      timePoint: '2024',
                      geometryOutputIds: ['geometry-2'],
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    })

    const topLevelChart = parsed.content?.[1]
    expect(topLevelChart).toMatchObject({
      type: 'chart',
      attrs: {
        height: 360,
      },
    })
    expect(topLevelChart?.attrs).not.toHaveProperty('productId')

    expect(extractReportProductRunIds(parsed)).toEqual(['run-1', 'run-2'])
    expect(extractReportIndicatorSelections(parsed)).toEqual([
      {
        productRunId: 'run-1',
        indicatorIds: ['indicator-1'],
      },
      {
        productRunId: 'run-2',
        indicatorIds: ['indicator-2'],
      },
    ])
    expect(extractReportChartReferences(parsed)).toEqual([
      expect.objectContaining({
        path: [1],
        height: 360,
        chart: expect.objectContaining({
          productRunId: 'run-1',
        }),
      }),
      expect.objectContaining({
        path: [2, 0, 1],
        height: null,
        chart: expect.objectContaining({
          productRunId: 'run-2',
        }),
      }),
    ])
  })

  it('allows unconfigured chart nodes and ignores them during extraction', () => {
    const parsed = reportTiptapDocumentSchema.parse({
      type: 'doc',
      content: [
        {
          type: 'chart',
          attrs: {
            chart: null,
            height: null,
          },
        },
      ],
    })

    expect(extractReportChartReferences(parsed)).toEqual([])
    expect(extractReportProductRunIds(parsed)).toEqual([])
  })

  it('rejects invalid chart configurations embedded in report content', () => {
    const result = reportTiptapDocumentSchema.safeParse({
      type: 'doc',
      content: [
        {
          type: 'chart',
          attrs: {
            chart: {
              type: 'plot',
              subType: 'donut',
              ...basePlotSelections,
              indicatorIds: ['indicator-1', 'indicator-2'],
              timePoints: ['2024', '2025'],
            },
          },
        },
      ],
    })

    expect(result.success).toBe(false)

    if (result.success) {
      throw new Error('Expected invalid chart content to fail')
    }

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['content', 0, 'attrs', 'chart', 'indicatorIds'],
          message:
            'Donut chart can only vary one dimension — select a single indicator',
        }),
        expect.objectContaining({
          path: ['content', 0, 'attrs', 'chart', 'timePoints'],
          message:
            'Donut chart can only vary one dimension — select a single time point',
        }),
      ]),
    )
  })
})

describe('dashboardContentSchema', () => {
  it('parses typed chart records and strips deprecated productId fields', () => {
    const parsed = dashboardContentSchema.parse({
      charts: {
        main: {
          type: 'plot',
          subType: 'line',
          ...basePlotSelections,
          productId: 'legacy-product',
        },
      },
      layout: [{ i: 'main', x: 0, y: 0, w: 4, h: 3 }],
    })

    expect(parsed.charts.main).not.toHaveProperty('productId')
    expect(parsed.layout).toEqual([{ i: 'main', x: 0, y: 0, w: 4, h: 3 }])
  })
})

describe('OpenAPI generation', () => {
  it('includes report and dashboard chart schemas in the generated document', () => {
    const app = new OpenAPIHono()

    app.openapi(
      createRoute({
        method: 'get',
        path: '/reports/{id}',
        request: {
          params: z.object({ id: z.string() }),
        },
        responses: {
          200: {
            description: 'Report response',
            content: {
              'application/json': {
                schema: fullReportSchema,
              },
            },
          },
        },
      }),
      (() => new Response()) as never,
    )

    app.openapi(
      createRoute({
        method: 'get',
        path: '/dashboards/{id}',
        request: {
          params: z.object({ id: z.string() }),
        },
        responses: {
          200: {
            description: 'Dashboard response',
            content: {
              'application/json': {
                schema: fullDashboardSchema,
              },
            },
          },
        },
      }),
      (() => new Response()) as never,
    )

    const document = app.getOpenAPIDocument({
      openapi: '3.0.0',
      info: {
        title: 'Schema smoke test',
        version: '1.0.0',
      },
    })

    expect(
      document.components?.schemas?.ReportStoredContentSchema,
    ).toBeDefined()
    expect(document.components?.schemas?.DashboardContentSchema).toBeDefined()
    expect(document.components?.schemas?.ChartConfigurationSchema).toBeDefined()
    expect(
      (
        document.components?.schemas?.ChartConfigurationSchema as {
          description?: string
        }
      )?.description,
    ).toContain('Persisted chart configuration')
    expect(
      JSON.stringify(document.components?.schemas?.DashboardContentSchema),
    ).toContain('ChartConfigurationSchema')
    expect(document.components?.schemas?.ReportContentSchema).toBeUndefined()
    expect(
      JSON.stringify(document.components?.schemas?.ReportSchemaFull),
    ).toContain('ReportStoredContentSchema')
  })
})

import { z } from '@hono/zod-openapi'
import { MultiPolygonSchema, PolygonSchema, WKBSchema } from './geojson'
import type { MultiPolygon } from 'geojson'
import { chartConfigurationSchema } from './chart'

const fileSchema = z.instanceof(File).openapi('FileSchema', {
  title: 'File',
  type: 'string',
  format: 'binary',
  description: 'Multipart/form-data file (binary)',
})

/* BASE RESOURCE SCHEMAS */
export const baseIdResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export const baseIdResourceSchemaWithMainRunId = baseIdResourceSchema.extend({
  mainRunId: z.string().nullable(),
})

export const baseResourceSchema = baseIdResourceSchema.extend({
  description: z.string().nullable(),
  metadata: z.any().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const baseRunResourceSchema = baseResourceSchema.extend({
  imageCode: z.string().nullable(),
  imageTag: z.string().nullable(),
  provenanceJson: z.any().nullable(),
  provenanceUrl: z.string().nullable(),
  dataUrl: z.string().nullable(),
  dataType: z
    .enum(['parquet', 'geoparquet', 'stac-geoparquet', 'zarr'])
    .nullable(),
  dataSize: z.number().int().nullable(),
  dataEtag: z.string().nullable(),
})

export const baseQuerySchema = z.object({
  page: z.coerce.number().positive().optional(),
  size: z.coerce.number().optional(),
  search: z.string().optional(),
  sort: z.enum(['name', 'createdAt', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
})

export const baseCreateResourceSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  metadata: z.any().optional(),
})

export const baseCreateRunResourceSchema = baseCreateResourceSchema.extend({
  imageCode: z.string().optional(),
  imageTag: z.string().optional(),
  provenanceJson: z.any().optional(),
  provenanceUrl: z.string().optional(),
  dataUrl: z.string().optional(),
  dataType: z
    .enum(['parquet', 'geoparquet', 'stac-geoparquet', 'zarr'])
    .optional(),
  dataSize: z.number().int().optional(),
  dataEtag: z.string().optional(),
})

export const baseUpdateResourceSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
})

/* INDICATOR RESOURCE SCHEMAS */
export const baseMeasuredIndicatorSchema = baseResourceSchema
  .extend({
    unit: z.string(),
    category: baseResourceSchema.nullable(),
    displayOrder: z.number().int().nullable(),
    categoryId: z.string().nullable(),
    type: z.literal('measured'),
  })
  .openapi('MeasuredIndicatorSchemaBase')

export const fullMeasuredIndicatorSchema = baseMeasuredIndicatorSchema
  .extend({
    productCount: z.number().int(),
    reportCount: z.number().int(),
    dashboardCount: z.number().int(),
  })
  .openapi('MeasuredIndicatorSchemaFull')

export const indicatorQuerySchema = baseQuerySchema.extend({
  indicatorIds: z.union([z.string(), z.array(z.string())]).optional(),
  excludeIndicatorIds: z.union([z.string(), z.array(z.string())]).optional(),
  categoryId: z.union([z.string(), z.array(z.string())]).optional(),
  type: z.enum(['measure', 'derived', 'all']).optional(),
})

export const createIndicatorSchema = baseCreateResourceSchema.extend({
  name: z.string(),
  unit: z.string(),
  categoryId: z.string().nullable().optional(),
  displayOrder: z.number().optional(),
})

export const updateIndicatorSchema = baseUpdateResourceSchema.extend({
  unit: z.string().optional(),
  categoryId: z.string().nullable().optional(),
  displayOrder: z.number().nullable().optional(),
})

export const baseDerivedIndicatorSchema = baseMeasuredIndicatorSchema
  .extend({
    expression: z.string(),
    type: z.literal('derived'),
  })
  .openapi('DerivedIndicatorSchemaBase')

export const fullDerivedIndicatorSchema = baseDerivedIndicatorSchema
  .extend({
    indicators: z.array(baseMeasuredIndicatorSchema),
    productCount: z.number().int(),
    reportCount: z.number().int(),
    dashboardCount: z.number().int(),
  })
  .openapi('DerivedIndicatorSchemaFull')

export const anyBaseIndicatorSchema = z.union([
  baseMeasuredIndicatorSchema,
  baseDerivedIndicatorSchema,
])

export const anyFullIndicatorSchema = z.union([
  fullMeasuredIndicatorSchema,
  fullDerivedIndicatorSchema,
])

export const createDerivedIndicatorSchema = createIndicatorSchema.extend({
  expression: z.string(),
  indicatorIds: z.array(z.string()),
})

export const updateDerivedIndicatorSchema = updateIndicatorSchema

/* INDICATOR CATEGORY RESOURCE SCHEMAS */
export const indicatorCategorySchema = baseResourceSchema
  .extend({
    parentId: z.string().nullable(),
    displayOrder: z.number().int().nullable(),
  })
  .openapi('IndicatorCategorySchemaBase')

export const createIndicatorCategorySchema = baseCreateResourceSchema.extend({
  name: z.string().min(1),
  parentId: z.string().optional(),
  displayOrder: z.number().optional(),
})

export const updateIndicatorCategorySchema = baseUpdateResourceSchema.extend({
  parentId: z.string().optional(),
  displayOrder: z.number().optional(),
})

/* DATASET RESOURCE SCHEMAS */
export const baseDatasetRunSchema = baseRunResourceSchema
  .extend({
    dataset: baseIdResourceSchemaWithMainRunId,
  })
  .openapi('DatasetRunBase')

export const fullDatasetRunSchema = baseDatasetRunSchema
  .extend({
    productRunCount: z.number().int(),
    reportCount: z.number().int(),
    dashboardCount: z.number().int(),
  })
  .openapi('DatasetRunFull')

export const baseDatasetSchema = baseResourceSchema
  .extend({
    mainRunId: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    sourceMetadataUrl: z.string().nullable(),
  })
  .openapi('DatasetBase')

export const fullDatasetSchema = baseDatasetSchema
  .extend({
    runCount: z.number().int(),
    productCount: z.number().int(),
    reportCount: z.number().int(),
    dashboardCount: z.number().int(),
    mainRun: baseDatasetRunSchema.nullable(),
  })
  .openapi('DatasetFull')

export const datasetQuerySchema = baseQuerySchema.extend({
  datasetIds: z.union([z.string(), z.array(z.string())]).optional(),
  excludeDatasetIds: z.union([z.string(), z.array(z.string())]).optional(),
})

export const createDatasetSchema = baseCreateResourceSchema.extend({
  sourceUrl: z.string().optional(),
  sourceMetadataUrl: z.string().optional(),
})

export const updateDatasetSchema = baseUpdateResourceSchema.extend({
  mainRunId: z.string().nullable().optional(),
})

export const datasetRunQuerySchema = baseQuerySchema

export const createDatasetRunSchema = baseCreateRunResourceSchema.extend({
  datasetId: z.string(),
})

export const updateDatasetRunSchema = baseUpdateResourceSchema

/* GEOMETRIES RESOURCE SCHEMAS */
export const baseGeometriesRunSchema = baseRunResourceSchema
  .extend({
    geometries: baseIdResourceSchemaWithMainRunId,
    dataPmtilesUrl: z.string().nullable(),
  })
  .openapi('GeometriesRunBase')

export const fullGeometriesRunSchema = baseGeometriesRunSchema
  .extend({
    productRunCount: z.number().int(),
    outputCount: z.number().int(),
    reportCount: z.number().int(),
    dashboardCount: z.number().int(),
    bounds: z.object({
      minX: z.number(),
      minY: z.number(),
      maxX: z.number(),
      maxY: z.number(),
    }),
  })
  .openapi('GeometriesRunFull')

export const baseGeometriesSchema = baseResourceSchema
  .extend({
    mainRunId: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    sourceMetadataUrl: z.string().nullable(),
  })
  .openapi('GeometriesBase')

export const fullGeometriesSchema = baseGeometriesSchema
  .extend({
    runCount: z.number().int(),
    productCount: z.number().int(),
    reportCount: z.number().int(),
    dashboardCount: z.number().int(),
    mainRun: baseGeometriesRunSchema.nullable(),
  })
  .openapi('GeometriesFull')

export const geometriesQuerySchema = baseQuerySchema.extend({
  geometriesIds: z.union([z.string(), z.array(z.string())]).optional(),
  excludeGeometriesIds: z.union([z.string(), z.array(z.string())]).optional(),
})

export const createGeometriesSchema = baseCreateResourceSchema.extend({
  sourceUrl: z.string().optional(),
  sourceMetadataUrl: z.string().optional(),
})

export const updateGeometriesSchema = baseUpdateResourceSchema.extend({
  mainRunId: z.string().nullable().optional(),
})

export const geometriesRunQuerySchema = baseQuerySchema

export const createGeometriesRunSchema = baseCreateRunResourceSchema.extend({
  // Override dataType to be geoparquet
  dataType: z.enum(['geoparquet']).optional(),
  dataPmtilesUrl: z.string().optional(),
  geometriesId: z.string(),
})

export const updateGeometriesRunSchema = baseUpdateResourceSchema.extend({})

/* GEOMETRY OUTPUT RESOURCE SCHEMAS */
export const baseGeometryOutputSchema = baseResourceSchema
  .extend({
    properties: z.any(),
    geometriesRun: baseIdResourceSchema.extend({
      geometries: baseIdResourceSchemaWithMainRunId,
    }),
  })
  .openapi('GeometryOutputBase')

const outputGeometrySchema = z
  .union([
    PolygonSchema.openapi({ title: 'GeoJSON Polygon' }),
    MultiPolygonSchema.openapi({ title: 'GeoJSON MultiPolygon' }),
  ])
  .openapi('GeometrySchema')

export const fullGeometryOutputSchema = baseGeometryOutputSchema
  .extend({
    geometry: outputGeometrySchema,
  })
  .openapi('GeometryOutputFull')

export const geometryOutputExportSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    properties: z.any(),
    geometry: outputGeometrySchema,
  })
  .openapi('GeometryOutputExportSchema')

export const geometryOutputQuerySchema = baseQuerySchema.extend({
  geometryOutputIds: z.union([z.string(), z.array(z.string())]).optional(),
  excludeGeometryOutputIds: z
    .union([z.string(), z.array(z.string())])
    .optional(),
})

export const geometryOutputExportQuerySchema = z.object({
  geometryOutputIds: z.union([z.string(), z.array(z.string())]).optional(),
})

const inputGeometrySchema = z
  .union([
    PolygonSchema.openapi({ title: 'GeoJSON Polygon' }),
    MultiPolygonSchema.openapi({
      title: 'GeoJSON MultiPolygon',
    }),
    WKBSchema.openapi({ title: 'WKB' }),
  ])
  .transform((data) => {
    if (data.type === 'Polygon') {
      const polygon = PolygonSchema.parse(data)
      return {
        type: 'MultiPolygon',
        coordinates: [polygon.coordinates],
        bbox: polygon.bbox,
      } satisfies MultiPolygon
    }
    return MultiPolygonSchema.parse(data)
  })

export const createGeometryOutputSchema = baseCreateResourceSchema.extend({
  name: z.string(),
  geometriesRunId: z.string(),
  geometry: inputGeometrySchema,
  properties: z.any().optional(),
})

export const createManyGeometryOutputSchema = z.object({
  geometriesRunId: z.string(),
  outputs: z.array(
    baseCreateResourceSchema.extend({
      name: z.string(),
      geometry: inputGeometrySchema,
      properties: z.any().optional(),
    }),
  ),
})

export const importGeometryOutputsSchema = z.object({
  geometriesRunId: z.string(),
  geojsonIdProperty: z.string(),
  geojsonNameProperty: z.string(),
  geojsonFile: fileSchema,
})

export const updateGeometryOutputSchema = baseUpdateResourceSchema.omit({
  name: true,
})

/* PRODUCT RESOURCE SCHEMAS */
export const baseProductRunOutputSummarySchema = z
  .object({
    startTime: z.date().nullable(),
    endTime: z.date().nullable(),
    outputCount: z.number().int(),
    timePoints: z.array(z.date()).nullable(),
    indicators: z.array(anyBaseIndicatorSchema),
  })
  .openapi('ProductRunOutputSummaryBase')

export const fullProductRunOutputSummarySchema = z
  .object({
    startTime: z.date().nullable(),
    endTime: z.date().nullable(),
    outputCount: z.number().int(),
    timePoints: z.array(z.date()).nullable(),
    indicators: z.array(
      z.object({
        minValue: z.number().nullable(),
        maxValue: z.number().nullable(),
        avgValue: z.number().nullable(),
        count: z.number().int(),
        lastUpdated: z.date(),
        indicator: anyBaseIndicatorSchema.nullable(),
      }),
    ),
  })
  .openapi('ProductRunOutputSummaryFull')

export const baseProductRunSchema = baseRunResourceSchema
  .extend({
    product: baseIdResourceSchemaWithMainRunId,
    datasetRun: baseIdResourceSchema.nullable(),
    geometriesRun: baseIdResourceSchema.nullable(),
    outputSummary: baseProductRunOutputSummarySchema,
  })
  .openapi('ProductRunBase')

// Schema for assigned derived indicator with its dependency mappings
export const assignedDerivedIndicatorWithDependenciesSchema = z
  .object({
    id: z.string(),
    derivedIndicator: baseDerivedIndicatorSchema,
    dependencies: z.array(
      z.object({
        indicator: baseMeasuredIndicatorSchema,
        sourceProductRun: baseIdResourceSchema,
      }),
    ),
  })
  .openapi('AssignedDerivedIndicatorWithDependenciesSchema')

export const fullProductRunSchema = baseProductRunSchema
  .extend({
    datasetRun: baseDatasetRunSchema.nullable(),
    geometriesRun: baseGeometriesRunSchema.nullable(),
    outputSummary: fullProductRunOutputSummarySchema,
    reportCount: z.number().int(),
    dashboardCount: z.number().int(),
  })
  .openapi('ProductRunFull')

export const baseProductSchema = baseResourceSchema
  .extend({
    timePrecision: z.enum(['hour', 'day', 'month', 'year']),
    mainRunId: z.string().nullable(),
    dataset: baseIdResourceSchema.nullable(),
    geometries: baseIdResourceSchema.nullable(),
    mainRun: baseProductRunSchema.nullable(),
  })
  .openapi('ProductBase')

export const fullProductSchema = baseProductSchema
  .extend({
    dataset: fullDatasetSchema
      .omit({
        runCount: true,
        productCount: true,
        reportCount: true,
        dashboardCount: true,
      })
      .nullable(),
    geometries: fullGeometriesSchema
      .omit({
        runCount: true,
        productCount: true,
        reportCount: true,
        dashboardCount: true,
      })
      .nullable(),
    mainRun: fullProductRunSchema
      .omit({ reportCount: true, dashboardCount: true })
      .nullable(),
    runCount: z.number().int(),
    reportCount: z.number().int(),
    dashboardCount: z.number().int(),
  })
  .openapi('ProductFull')

export const productQuerySchema = baseQuerySchema.extend({
  productIds: z.union([z.string(), z.array(z.string())]).optional(),
  excludeProductIds: z.union([z.string(), z.array(z.string())]).optional(),
  datasetId: z.union([z.string(), z.array(z.string())]).optional(),
  geometriesId: z.union([z.string(), z.array(z.string())]).optional(),
  indicatorId: z.union([z.string(), z.array(z.string())]).optional(),
  hasRun: z.enum(['true', 'false']).optional(),
})

export const createProductSchema = baseCreateResourceSchema.extend({
  datasetId: z.string().optional(),
  geometriesId: z.string().optional(),
  timePrecision: z.enum(['hour', 'day', 'month', 'year']),
})

export const updateProductSchema = baseUpdateResourceSchema.extend({
  mainRunId: z.string().nullable().optional(),
  timePrecision: z.enum(['hour', 'day', 'month', 'year']).optional(),
})

export const productRunQuerySchema = baseQuerySchema.extend({
  datasetRunId: z.string().optional(),
  geometriesRunId: z.string().optional(),
})

export const createProductRunSchema = baseCreateRunResourceSchema.extend({
  dataType: z.enum(['parquet']).optional(),
  productId: z.string(),
  datasetRunId: z.string().optional(),
  geometriesRunId: z.string().optional(),
})

export const updateProductRunSchema = baseUpdateResourceSchema

// Schema for assigning a derived indicator's dependency mappings
export const assignedDerivedIndicatorDependencySchema = z
  .object({
    indicatorId: z.string().min(1),
    sourceProductRunId: z.string().min(1),
  })
  .openapi('AssignedDerivedIndicatorDependencySchema')

export const productRunAssignDerivedIndicatorSchema = z
  .object({
    derivedIndicatorId: z.string().min(1),
    dependencies: z.array(assignedDerivedIndicatorDependencySchema),
  })
  .openapi('ProductRunAssignDerivedIndicatorSchema')

/* PRODUCT OUTPUT RESOURCE SCHEMAS */
export const baseProductOutputSchema = baseResourceSchema
  .extend({
    value: z.number(),
    timePoint: z.iso.datetime(),
    productRun: baseIdResourceSchema.extend({
      product: baseIdResourceSchemaWithMainRunId,
      datasetRun: baseIdResourceSchema
        .extend({
          dataset: baseIdResourceSchemaWithMainRunId,
        })
        .nullable(),
      geometriesRun: baseIdResourceSchema
        .extend({
          geometries: baseIdResourceSchemaWithMainRunId,
        })
        .nullable(),
    }),
    geometryOutput: baseGeometryOutputSchema.nullable().optional(),
    indicator: anyBaseIndicatorSchema.nullable(),
  })
  .openapi('ProductOutputBase')

export const fullProductOutputSchema = baseProductOutputSchema
  .extend({
    geometryOutput: fullGeometryOutputSchema.nullable().optional(),
    dependencyProductOutputs: z.array(baseProductOutputSchema),
  })
  .openapi('ProductOutputFull')

export const productOutputExportSchema = z
  .object({
    id: z.string(),
    indicatorId: z.string().nullable(),
    indicatorName: z.string().nullable(),
    indicatorType: z.enum(['measured', 'derived']),
    timePoint: z.iso.datetime(),
    geometryOutputId: z.string().optional(),
    geometryOutputName: z.string().optional(),
    value: z.number(),
  })
  .openapi('ProductOutputExportSchema')

export const productOutputQuerySchema = baseQuerySchema.extend({
  geometryOutputId: z.union([z.string(), z.array(z.string())]).optional(),
  indicatorId: z.union([z.string(), z.array(z.string())]).optional(),
  timePoint: z.iso.datetime().optional(),
  sort: z
    .enum(['name', 'createdAt', 'updatedAt', 'value', 'timePoint'])
    .optional(),
})

export const productOutputExportQuerySchema = z.object({
  indicatorId: z.union([z.string(), z.array(z.string())]).optional(),
  geometryOutputId: z.union([z.string(), z.array(z.string())]).optional(),
  timePoint: z.union([z.iso.datetime(), z.array(z.iso.datetime())]).optional(),
})

export const createProductOutputSchema = baseCreateResourceSchema.extend({
  productRunId: z.string(),
  geometryOutputId: z.string(),
  value: z.union([z.number(), z.string()]).transform((data) => {
    if (typeof data === 'string') {
      return parseFloat(data)
    }
    return data
  }),
  indicatorId: z.string(),
  timePoint: z.iso.datetime(),
})

export const updateProductOutputSchema = baseUpdateResourceSchema

export const createManyProductOutputSchema = z.object({
  productRunId: z.string(),
  indicatorId: z.string(),
  timePoint: z.iso.datetime(),
  outputs: z.array(
    baseCreateResourceSchema.extend({
      geometryOutputId: z.string(),
      value: z.number(),
    }),
  ),
})

export const importProductOutputColumnMappingSchema = z.array(
  z.object({
    column: z.string(),
    indicatorId: z.string(),
    timePoint: z.iso.datetime(),
  }),
)

export const importProductOutputsSchema = z.object({
  productRunId: z.string(),
  geometryColumn: z.string(),
  indicatorMappings: z
    .union([importProductOutputColumnMappingSchema, z.string()])
    .transform((data) => {
      if (typeof data === 'string') {
        return importProductOutputColumnMappingSchema.parse(JSON.parse(data))
      }
      return data
    }),
  csvFile: fileSchema,
})

/* REPORT RESOURCE SCHEMAS */

export const baseReportSchema = baseResourceSchema.openapi('ReportSchemaBase')
export const reportStoredContentSchema = z
  .record(z.string(), z.unknown())
  .openapi('ReportStoredContentSchema', {
    type: 'object',
    additionalProperties: true,
    description:
      'Opaque report document payload. It is currently stored as Tiptap JSON, but clients should treat the structure as an implementation detail.',
  })

export const fullReportSchema = baseReportSchema
  .extend({ content: reportStoredContentSchema.nullable() })
  .openapi('ReportSchemaFull')

export const reportQuerySchema = baseQuerySchema.extend({
  indicatorId: z.union([z.string(), z.array(z.string())]).optional(),
  productId: z.union([z.string(), z.array(z.string())]).optional(),
  productRunId: z.string().optional(),
  datasetId: z.union([z.string(), z.array(z.string())]).optional(),
  datasetRunId: z.string().optional(),
  geometriesId: z.union([z.string(), z.array(z.string())]).optional(),
  geometriesRunId: z.string().optional(),
})
export const createReportSchema = baseCreateResourceSchema
export const updateReportSchema = baseUpdateResourceSchema.extend({
  content: reportStoredContentSchema.nullable(),
})

/* DASHBOARD RESOURCE SCHEMAS */
export const gridLayoutItemSchema = z
  .object({
    i: z.string(),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    minH: z.number().optional(),
    minW: z.number().optional(),
    maxH: z.number().optional(),
    maxW: z.number().optional(),
    static: z.boolean().optional(),
    isDraggable: z.boolean().optional(),
    isResizable: z.boolean().optional(),
    moved: z.boolean().optional(),
  })
  .openapi('DashboardGridLayoutItemSchema', {
    description: 'Layout item for a dashboard chart card.',
  })

export const dashboardLayoutSchema = z.array(gridLayoutItemSchema)

export const dashboardContentSchema = z
  .object({
    charts: z.record(z.string(), chartConfigurationSchema),
    layout: dashboardLayoutSchema,
  })
  .openapi('DashboardContentSchema', {
    description:
      'Typed dashboard content. Each chart card uses the shared persisted chart schema.',
  })

export type DashboardContent = z.infer<typeof dashboardContentSchema>

export const baseDashboardSchema = baseResourceSchema.openapi(
  'DashboardSchemaBase',
)

export const fullDashboardSchema = baseDashboardSchema
  .extend({
    content: dashboardContentSchema,
  })
  .openapi('DashboardSchemaFull')

export const dashboardQuerySchema = baseQuerySchema.extend({
  indicatorId: z.union([z.string(), z.array(z.string())]).optional(),
  productId: z.union([z.string(), z.array(z.string())]).optional(),
  productRunId: z.string().optional(),
  datasetId: z.union([z.string(), z.array(z.string())]).optional(),
  datasetRunId: z.string().optional(),
  geometriesId: z.union([z.string(), z.array(z.string())]).optional(),
  geometriesRunId: z.string().optional(),
})
export const createDashboardSchema = baseCreateResourceSchema.extend({
  content: dashboardContentSchema,
})
export const updateDashboardSchema = baseUpdateResourceSchema.extend({
  content: dashboardContentSchema.optional(),
})

import { z } from 'zod'
import {
  chartConfigurationSchema,
  extractChartIndicatorSelection,
  type ChartIndicatorSelection,
  type ChartConfiguration,
} from './chart'

export type ReportMark = {
  type: string
  attrs?: Record<string, unknown>
  [key: string]: unknown
}

export type ReportContentNode = {
  type?: string
  attrs?: Record<string, unknown>
  content?: ReportContentNode[]
  marks?: ReportMark[]
  text?: string
  [key: string]: unknown
}

export type ReportChartNodeAttributes = {
  chart?: ChartConfiguration | null
  height?: number | null
  [key: string]: unknown
}

export type ReportChartNode = Omit<ReportContentNode, 'type' | 'attrs'> & {
  type: 'chart'
  attrs?: ReportChartNodeAttributes
}

export type ReportTiptapDocument = {
  type: 'doc'
  attrs?: Record<string, unknown>
  content?: ReportContentNode[]
  marks?: ReportMark[]
  text?: string
  [key: string]: unknown
}

export type ReportChartReference = {
  chart: ChartConfiguration
  height: number | null
  path: number[]
}

export const reportMarkSchema: z.ZodType<ReportMark> = z
  .object({
    type: z.string(),
    attrs: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

export const reportChartNodeAttributesSchema: z.ZodType<ReportChartNodeAttributes> =
  z
    .object({
      chart: chartConfigurationSchema.nullable().optional(),
      height: z.number().nullable().optional(),
    })
    .passthrough()

const reportChartNodeValidationSchema = z.object({
  type: z.literal('chart'),
  attrs: reportChartNodeAttributesSchema.optional(),
})

export const reportContentNodeSchema: z.ZodType<ReportContentNode> = z.lazy(
  () =>
    z
      .object({
        type: z.string().optional(),
        attrs: z.record(z.string(), z.unknown()).optional(),
        content: z.array(reportContentNodeSchema).optional(),
        marks: z.array(reportMarkSchema).optional(),
        text: z.string().optional(),
      })
      .passthrough()
      .superRefine((node, ctx) => {
        if (node.type !== 'chart') return

        const result = reportChartNodeValidationSchema.safeParse(node)

        if (!result.success) {
          for (const issue of result.error.issues) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: issue.path,
              message: issue.message,
            })
          }
        }
      }),
)

export const reportTiptapDocumentSchema: z.ZodType<ReportTiptapDocument> = z
  .object({
    type: z.literal('doc'),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(reportContentNodeSchema).optional(),
    marks: z.array(reportMarkSchema).optional(),
    text: z.string().optional(),
  })
  .passthrough()

export const parseReportStoredContent = (
  content: unknown,
): ReportTiptapDocument => reportTiptapDocumentSchema.parse(content)

export const parseNullableReportStoredContent = (
  content: unknown,
): ReportTiptapDocument | null =>
  content === null ? null : reportTiptapDocumentSchema.parse(content)

const collectReportChartReferences = (
  node: ReportContentNode,
  path: number[],
  references: ReportChartReference[],
) => {
  if (node.type === 'chart') {
    const parsedChartNode = reportChartNodeValidationSchema.safeParse(node)

    if (parsedChartNode.success && parsedChartNode.data.attrs?.chart) {
      references.push({
        chart: parsedChartNode.data.attrs.chart,
        height: parsedChartNode.data.attrs.height ?? null,
        path,
      })
    }
  }

  node.content?.forEach((child, index) => {
    collectReportChartReferences(child, [...path, index], references)
  })
}

export const extractReportChartReferences = (
  content: unknown,
): ReportChartReference[] => {
  const document = parseReportStoredContent(content)
  const references: ReportChartReference[] = []

  document.content?.forEach((node, index) => {
    collectReportChartReferences(node, [index], references)
  })

  return references
}

export const extractReportProductRunIds = (content: unknown): string[] =>
  Array.from(
    new Set(
      extractReportChartReferences(content).map(
        ({ chart }) => chart.productRunId,
      ),
    ),
  )

export const extractReportIndicatorSelections = (
  content: unknown,
): ChartIndicatorSelection[] =>
  extractReportChartReferences(content).map(({ chart }) =>
    extractChartIndicatorSelection(chart),
  )

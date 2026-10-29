import { z } from '@hono/zod-openapi'
import type { Position, BBox, Polygon, MultiPolygon } from 'geojson'
import wkx from 'wkx'

// Adapted from https://github.com/timbtimbtimb/zod-geojson-schemas
// Under MIT license Copyright (c) 2025 Timothée Billiet Cadart
// Full License: https://github.com/timbtimbtimb/zod-geojson-schemas/blob/production/LICENSE

export const PositionSchema = z
  .array(z.number())
  .min(2) satisfies z.ZodType<Position>

export const BBoxSchema = z.union([
  z.tuple([z.number(), z.number(), z.number(), z.number()]),
  z.tuple([
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
  ]),
]) satisfies z.ZodType<BBox>

export const PolygonSchema = z.object({
  type: z.literal('Polygon'),
  bbox: BBoxSchema.optional(),
  coordinates: z.array(z.array(PositionSchema)),
}) satisfies z.ZodType<Polygon>

export const MultiPolygonSchema = z.object({
  type: z.literal('MultiPolygon'),
  bbox: BBoxSchema.optional(),
  coordinates: z.array(z.array(z.array(PositionSchema))),
}) satisfies z.ZodType<MultiPolygon>

export const WKBSchema = z
  .object({
    wkb: z.string().openapi({
      title: 'WKB',
      description:
        'Well-Known Binary (WKB) base64 representation of a geometry. Only Polygon and MultiPolygon are supported. Must be in WGS84 (EPSG:4326).',
      format: 'base64',
    }),
  })
  .openapi('WKBSchema', {
    title: 'WKB',
    description: 'Well-Known Binary (WKB) base64 representation of a geometry.',
    format: 'base64',
  })
  .transform((value) => {
    const b = Buffer.from(value.wkb, 'base64')
    const geometry = wkx.Geometry.parse(b)

    if (geometry.srid !== 4326) {
      throw new Error(
        `Invalid WKB ("${value.wkb}") - only SRID 4326 is supported`,
      )
    }

    if (
      geometry instanceof wkx.Polygon ||
      geometry instanceof wkx.MultiPolygon
    ) {
      return geometry.toGeoJSON({ shortCrs: true }) as Polygon | MultiPolygon
    }

    throw new Error('Invalid WKB - only Polygon and MultiPolygon are supported')
  }) satisfies z.ZodType<Polygon | MultiPolygon>

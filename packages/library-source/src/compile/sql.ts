import type { SqlValue, SqliteExecutor } from '../driver'

/**
 * A piece of SQL with its bound parameters. Values always travel as
 * parameters; the text holds only SQL written in this package. Build
 * fragments with the `sql` tag and combine them with the helpers below.
 */
export class Sql {
  constructor(
    readonly text: string,
    readonly params: readonly SqlValue[],
  ) {}
}

type SqlPart = Sql | SqlValue

/**
 * `sql\`t.rid = ${id}\`` binds `id`; an interpolated `Sql` is inlined with
 * its own parameters.
 */
export function sql(
  strings: TemplateStringsArray,
  ...parts: readonly SqlPart[]
): Sql {
  let text = strings[0] ?? ''
  const params: SqlValue[] = []
  parts.forEach((part, index) => {
    if (part instanceof Sql) {
      text += part.text
      params.push(...part.params)
    } else {
      text += '?'
      params.push(part)
    }
    text += strings[index + 1] ?? ''
  })
  return new Sql(text, params)
}

export const TRUE = sql`1`
export const FALSE = sql`0`
export const EMPTY = sql``

/** Joins fragments with a separator written in this package, such as `, `. */
export function join(parts: readonly Sql[], separator: string): Sql {
  return new Sql(
    parts.map((part) => part.text).join(separator),
    parts.flatMap((part) => part.params),
  )
}

/** Every condition holds; true for none. */
export function and(conditions: readonly Sql[]): Sql {
  if (conditions.length === 0) return TRUE
  if (conditions.length === 1 && conditions[0] !== undefined)
    return conditions[0]
  return sql`(${join(conditions, ' AND ')})`
}

/** Some condition holds; false for none. */
export function or(conditions: readonly Sql[]): Sql {
  if (conditions.length === 0) return FALSE
  if (conditions.length === 1 && conditions[0] !== undefined)
    return conditions[0]
  return sql`(${join(conditions, ' OR ')})`
}

export function not(condition: Sql): Sql {
  return sql`NOT (${condition})`
}

/**
 * A list of values as a one-column subquery, bound as one JSON parameter,
 * for `x IN ${values(list)}`. The statement text does not depend on the
 * list's length.
 */
export function values(list: readonly (string | number)[]): Sql {
  return sql`(SELECT value FROM json_each(${JSON.stringify(list)}))`
}

/** Runs a statement and returns its rows. */
export function readRows(
  executor: SqliteExecutor,
  statement: Sql,
): Promise<Record<string, SqlValue>[]> {
  return executor.all(statement.text, statement.params)
}

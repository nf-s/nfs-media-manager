import { PickProperties } from "ts-essentials";

export type NumericColKey<T> = Exclude<
  keyof PickProperties<T, number | undefined>,
  undefined
>;
export type BooleanColKey<T> = Exclude<
  keyof PickProperties<T, boolean | number | string | undefined>,
  undefined
>;
export type StringColKey<T> = Exclude<
  keyof PickProperties<T, string | undefined>,
  undefined
>;
export type IdColKey<T> = Exclude<keyof PickProperties<T, string>, undefined>;

export type FilterColKey<T> = Exclude<
  keyof PickProperties<T, string[] | string | undefined>,
  undefined
>;

export type FilterColArrayKey<T> = keyof PickProperties<T, string[]>;

export type SortColumnKey<T> = StringColKey<T> | NumericColKey<T>;
export type SortValue<T> = [SortColumnKey<T>, "ASC" | "DESC"];

export type FilterValue<T> = TextFilterValue<T> | NumericFilterValue<T>;

export type TextFilterValue<T> = {
  value: string;
  field: FilterColKey<T>;
  /** If true, the exclude fields which have specified value (treated as intersection) */
  exclude?: boolean;
  /** If true, then intersect filter (instead of union) */
  intersection?: boolean;
};

export type NumericFilterValue<T> = {
  min: number;
  max: number;
  field: NumericColKey<T>;
  includeUndefined: boolean;
};

export function isTextFilter<T>(
  filter: FilterValue<T>
): filter is TextFilterValue<T> {
  return "value" in filter;
}

export function isNumericFilter<T>(
  filter: FilterValue<T>
): filter is NumericFilterValue<T> {
  return "max" in filter;
}

export function applyFilters<T>(rows: T[], filters: FilterValue<T>[]) {
  return rows.filter((row) => {
    const includeTextFilters = filters
      .filter(isTextFilter)
      .filter((filter) => !filter.exclude && !filter.intersection);
    // Union all text filters (not exclude text filters)
    return (
      includeTextFilters.reduce<boolean>(
        (include, filter) => {
          const rowValue = row[filter.field];
          return (
            include ||
            (Array.isArray(rowValue) && rowValue.includes(filter.value)) ||
            (typeof rowValue === "string" && rowValue === filter.value)
          );
        },
        // Set default to `true` if no filters to apply
        includeTextFilters.length === 0
      ) &&
      // Intersect all `intersection` text filters
      filters
        .filter(isTextFilter)
        .filter((filter) => filter.intersection)
        .reduce<boolean>((include, filter) => {
          const rowValue = row[filter.field];
          return (
            include &&
            ((Array.isArray(rowValue) && rowValue.includes(filter.value)) ||
              (typeof rowValue === "string" && rowValue === filter.value))
          );
        }, true) &&
      // Intersect all EXCLUDE text filters
      filters
        .filter(isTextFilter)
        .filter((filter) => filter.exclude)
        .reduce<boolean>((include, filter) => {
          const rowValue = row[filter.field];
          return (
            include &&
            ((Array.isArray(rowValue) && !rowValue.includes(filter.value)) ||
              (typeof rowValue === "string" && rowValue !== filter.value))
          );
        }, true) &&
      // Intersect all numeric filters
      filters.filter(isNumericFilter).reduce<boolean>((include, filter) => {
        const rowValue = row[filter.field];
        return (
          include &&
          ((typeof rowValue === "number" &&
            rowValue <= filter.max &&
            rowValue >= filter.min) ||
            (typeof rowValue === "undefined" && filter.includeUndefined))
        );
      }, true)
    );
  });
}

export function applySort<T>(
  rows: T[],
  sort: SortValue<T>,
  includeUndefined = true
) {
  const sortedRows = rows
    .filter((row) => includeUndefined || typeof row[sort[0]] !== "undefined")
    .sort((a, b) => {
      const aValue = a[sort[0]];
      const bValue = b[sort[0]];

      if (typeof aValue === "string" && typeof bValue === "string")
        return (aValue ?? "").localeCompare(bValue ?? "");
      if (typeof aValue === "number" && typeof bValue === "number")
        return aValue - bValue;

      // Push undefined values to end of sort
      if (typeof aValue === "undefined") return -1;
      if (typeof bValue === "undefined") return 1;
      return 0;
    });

  return sort[1] === "DESC" ? sortedRows.reverse() : sortedRows;
}

export function timeToDateString(time: number) {
  const ye = new Intl.DateTimeFormat("en", { year: "numeric" });
  const mo = new Intl.DateTimeFormat("en", { month: "2-digit" });
  const da = new Intl.DateTimeFormat("en", { day: "2-digit" });

  const date = new Date(time);
  return `${ye.format(date)}/${mo.format(date)}/${da.format(date)}`;
}

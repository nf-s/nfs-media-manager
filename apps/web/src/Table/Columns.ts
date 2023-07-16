import {
  BooleanColKey,
  FilterColKey,
  IdColKey,
  NumericColKey,
  SortValue,
  StringColKey,
} from "data-types";
import { createContext } from "react";
import { Column } from "react-data-grid";
import { PickProperties } from "ts-essentials";

type ColumnBase = {
  readonly width?: number;
  readonly name: string;
  readonly resizable?: boolean;
};

export type ColumnKey<T> = keyof T | "Controls" | "Links";

export type DefaultVisible<T> = ColumnKey<T>[];

export type NumericCol<T> = {
  readonly sortable?: boolean;
  readonly type: "numeric";
  readonly key: NumericColKey<T>;
  /** Minimum value for filter. If left empty, this will be generated from column values */
  readonly min?: number | undefined;
  /** Maximum value for filter. If left empty, this will be generated from column values */
  readonly max?: number | undefined;
  /** If true, then value will be divided by `max`, and multiplied by `100` */
  readonly displayAsPercentOfMax?: boolean;
  readonly append?: string;
  /** Number of digits after the decimal point. Must be in the range 0 - 20, inclusive. */
  readonly precision?: number;
  readonly mult?: number | undefined;
  readonly default?: number;

  /** This overrides append, precision and mult */
  readonly numberFormat?: (num: number) => string;
} & ColumnBase;

export type BooleanCol<T> = {
  readonly type: "boolean";
  readonly key: BooleanColKey<T>;
} & ColumnBase;

export type StringCol<T> = (
  | // String columns
  {
      readonly key: keyof PickProperties<T, string | undefined>;
    }
  // Not string columns (require renderCell)
  | {
      readonly key: keyof PickProperties<T, Exclude<any, string>>;
      readonly fieldRenderer: ColumnFieldRenderer<T>;
    }
) & {
  readonly type: "string";

  readonly sortable?: boolean;
} & ColumnBase;

export type FilterCol<T> = StringCol<T> & {
  readonly enableFilter: true;
  readonly enableRowFilter?: boolean;
  readonly key: FilterColKey<T>;
  readonly filterLabel?: (value: string) => string;
};

export type DataColumn<T> =
  | FilterCol<T>
  | StringCol<T>
  | NumericCol<T>
  | BooleanCol<T>;

export type DataColumnKey<T> =
  | FilterColKey<T>
  | StringColKey<T>
  | NumericColKey<T>
  | BooleanColKey<T>;

export type ColumnFieldRendererProps<T> = {
  col: DataColumn<T>;
  data: T;
};
export type ColumnFieldRenderer<T> = (
  props: ColumnFieldRendererProps<T>
) => JSX.Element | null;

export type ColumnWithFieldRenderer<T> = Readonly<
  Column<T> & {
    fieldRenderer?: ColumnFieldRenderer<T>;
  }
>;

export type GridButtonsFC<T> = React.FC<{ row: T }>;

export type GridConfig<T> = {
  readonly width: number;
  readonly height: number;
  readonly art?: keyof PickProperties<T, string | undefined>;
  /** maximum of 3 columns */ readonly cols: [
    DataColumnKey<T>,
    DataColumnKey<T>,
    DataColumnKey<T>,
  ];
  readonly links?: (row: T) => JSX.Element;
  ButtonFC?: GridButtonsFC<T>;
};

export interface ColumnsConfig<T> {
  data: DataColumn<T>[];
  custom?: Column<T>[];
  grid: GridConfig<T>;
  id: IdColKey<T>;
  defaultSort: SortValue<T>;
  defaultVisible: ColumnKey<T>[];
}

export const ColumnConfigContext = createContext<
  ColumnsConfig<any> | undefined
>(undefined);

export function isNumericCol<T>(col: DataColumn<T>): col is NumericCol<T> {
  return col.type === "numeric";
}
export function getNumericCols<T>(
  cols: DataColumn<T>[] | undefined
): NumericCol<T>[] {
  return (cols ?? []).filter(isNumericCol);
}
export function isStringCol<T>(col: DataColumn<T>): col is StringCol<T> {
  return col.type === "string";
}
export function getStringCols<T>(
  cols: DataColumn<T>[] | undefined
): StringCol<T>[] {
  return (cols ?? []).filter(isStringCol);
}
export function isBooleanCol<T>(col: DataColumn<T>): col is BooleanCol<T> {
  return col.type === "boolean";
}
export function getBooleanCols<T>(
  cols: DataColumn<T>[] | undefined
): BooleanCol<T>[] {
  return (cols ?? []).filter(isBooleanCol);
}

export function isFilterCol<T>(col: DataColumn<T>): col is FilterCol<T> {
  return (
    col.type === "string" && "enableFilter" in col && col.enableFilter === true
  );
}

export function getFilterCols<T>(
  cols: DataColumn<T>[] | undefined
): FilterCol<T>[] {
  return (cols ?? []).filter(isFilterCol);
}

import { PickProperties } from "ts-essentials";

export type NumericColKey<T> = keyof PickProperties<T, number | undefined>;
export type BooleanColKey<T> = keyof PickProperties<
  T,
  boolean | number | string | undefined
>;
export type StringColKey<T> = keyof PickProperties<T, string | undefined>;
export type FilterColKey<T> = keyof PickProperties<
  T,
  string[] | string | undefined
>;

export type FilterColArrayKey<T> = keyof PickProperties<T, string[]>;

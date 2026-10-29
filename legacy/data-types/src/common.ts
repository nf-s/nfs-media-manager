export interface Link {
  href?: string | undefined;
  title?: string | undefined;
}

export type Links<T extends string> = Record<T, Link>;

import type { ClassNamesConfig, GroupBase } from 'react-select'

/**
 * React-select classNames configuration that matches shadcn/ui Select styles.
 * Use with react-select's `classNames` prop and set `unstyled={true}`.
 *
 * @example
 * ```tsx
 * import { reactSelectClassNames } from '@repo/ui/lib/react-select-styles'
 *
 * <ReactSelect
 *   unstyled
 *   classNames={reactSelectClassNames}
 *   // ... other props
 * />
 * ```
 */
export function getReactSelectClassNames<
  Option,
  IsMulti extends boolean = false,
  Group extends GroupBase<Option> = GroupBase<Option>,
>(): ClassNamesConfig<Option, IsMulti, Group> {
  return {
    control: ({ isFocused, isDisabled }) =>
      [
        'flex min-h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background',
        isFocused && 'outline-none ring-2 ring-ring ring-offset-2',
        isDisabled && 'cursor-not-allowed opacity-50',
      ]
        .filter(Boolean)
        .join(' '),

    valueContainer: () => 'gap-1',

    singleValue: () => 'text-foreground',

    multiValue: () =>
      'bg-secondary text-secondary-foreground rounded-md px-1.5 py-0.5 text-xs font-medium',

    multiValueLabel: () => '',

    multiValueRemove: () =>
      'ml-1 rounded-sm opacity-70 hover:opacity-100 hover:bg-secondary-foreground/20',

    input: () => 'text-foreground placeholder:text-muted-foreground',

    placeholder: () => 'text-muted-foreground',

    indicatorsContainer: () => 'gap-1',

    indicatorSeparator: () => 'bg-border',

    dropdownIndicator: () => 'text-muted-foreground opacity-50',

    clearIndicator: () =>
      'text-muted-foreground opacity-50 hover:opacity-100 cursor-pointer',

    menu: () =>
      'mt-1 z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95',

    menuList: () => 'p-1 max-h-96',

    option: ({ isFocused, isDisabled }) =>
      [
        'relative flex w-full cursor-default select-none items-center rounded-sm py-2 px-4 !text-sm outline-none',
        isFocused && 'bg-accent text-accent-foreground',
        isDisabled && 'pointer-events-none opacity-50',
      ]
        .filter(Boolean)
        .join(' '),

    noOptionsMessage: () => 'py-6 text-center text-sm text-muted-foreground',

    loadingMessage: () => 'py-6 text-center text-sm text-muted-foreground',

    loadingIndicator: () => 'text-muted-foreground',

    group: () => '',

    groupHeading: () =>
      'py-1.5 px-2 text-sm font-semibold text-muted-foreground',
  }
}

/**
 * Pre-configured classNames for react-select.
 * For generic usage where you don't need to specify types.
 */
export const reactSelectClassNames = getReactSelectClassNames()

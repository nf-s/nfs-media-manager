'use client'

import ReactSelect, {
  InputActionMeta,
  Props as ReactSelectProps,
} from 'react-select'
import { useDebounceCallback } from 'usehooks-ts'
import { getReactSelectClassNames } from '@repo/ui/lib/react-select-styles'

export type { MultiValue, SingleValue } from 'react-select'

export type SelectOption = {
  id: string
  name?: string
}

export type SelectWithSearchProps<
  Option extends SelectOption,
  IsMulti extends boolean = false,
> = {
  onSearch?: (value: string | undefined) => void
  options: Option[] | undefined
} & ReactSelectProps<Option, IsMulti>

export function EmptyResult() {
  return 'No options found.'
}

export function SelectWithSearch<
  Option extends SelectOption,
  IsMulti extends boolean = false,
>({ onSearch, ...rest }: SelectWithSearchProps<Option, IsMulti>) {
  const debounced = useDebounceCallback(onSearch ?? (() => {}), 300)

  const handleInputChange = (inputText: string, meta: InputActionMeta) => {
    if (meta.action !== 'input-blur' && meta.action !== 'menu-close') {
      debounced(inputText)
    }
  }

  return (
    <ReactSelect<Option, IsMulti>
      unstyled
      classNames={getReactSelectClassNames<Option, IsMulti>()}
      getOptionLabel={(option) => option.name ?? option.id}
      getOptionValue={(option) => option.id}
      {...rest}
      filterOption={onSearch ? null : undefined}
      loadingMessage={() => 'Loading...'}
      noOptionsMessage={() => (rest.isLoading ? 'Loading...' : EmptyResult())}
      onInputChange={handleInputChange}
      placeholder={rest.placeholder ?? 'Select an option'}
    />
  )
}

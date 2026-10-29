'use client'

import { GroupBase, InputActionMeta } from 'react-select'
import CreatableSelect, { CreatableProps } from 'react-select/creatable'
import { useDebounceCallback } from 'usehooks-ts'
import { getReactSelectClassNames } from '@repo/ui/lib/react-select-styles'

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
} & CreatableProps<Option, IsMulti, GroupBase<Option>>

export function EmptyResult() {
  return 'No options found.'
}

export function SelectWithSearchWithCreate<
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
    <CreatableSelect<Option, IsMulti>
      unstyled
      classNames={getReactSelectClassNames<Option, IsMulti>()}
      getOptionLabel={(option) => {
        // Need to handle the create label (from formatCreateLabel)
        if (
          !option.id &&
          'label' in option &&
          typeof option.label === 'string'
        ) {
          return option.label
        }
        return option.name ?? option.id
      }}
      getOptionValue={(option) => option.id}
      formatCreateLabel={(input) => `Create "${input}"`}
      {...rest}
      filterOption={onSearch ? null : undefined}
      loadingMessage={() => 'Loading...'}
      noOptionsMessage={() => (rest.isLoading ? 'Loading...' : EmptyResult())}
      onInputChange={handleInputChange}
      placeholder={rest.placeholder ?? 'Select an option'}
    />
  )
}

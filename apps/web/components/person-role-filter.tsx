'use client'

import { PersonRoleSchema } from '@repo/schemas/creators'
import { personRoleLabels } from '@/utils/creator-browse'
import { BrowseColumnFilterSection } from './browse-toolbar'
import { useDetailView } from './detail-inspector-context'
import {
  SecondaryColumnFilter,
  type ColumnFilterProps,
} from './secondary-table'

export function usePersonRoleFilter() {
  const view = useDetailView()
  const selected = view.params.getAll('role')
  const roles = PersonRoleSchema.options.filter((role) =>
    selected.includes(role),
  )
  const options: ColumnFilterProps<(typeof roles)[number]> = {
    label: 'Role',
    options: PersonRoleSchema.options.map((value) => ({
      value,
      label: personRoleLabels[value],
    })),
    value: roles,
    onChange: (next) => {
      view.params.delete('role')
      for (const role of next) view.params.append('role', role)
      view.replace(view.params)
    },
  }
  return {
    filters: roles.length === 1 && roles[0] ? { role: roles[0] } : undefined,
    control: <SecondaryColumnFilter {...options} />,
    filterPanel: {
      count: roles.length === 1 ? 1 : 0,
      controls: <BrowseColumnFilterSection {...options} />,
    },
  }
}

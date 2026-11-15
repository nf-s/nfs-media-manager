'use client'

import { PersonRoleSchema } from '@repo/schemas/creators'
import { personRoleLabels } from '@/utils/creator-browse'
import { useDetailView } from './detail-inspector-context'
import { SecondaryColumnFilter } from './secondary-table'

export function usePersonRoleFilter() {
  const view = useDetailView()
  const selected = view.params.getAll('role')
  const roles = PersonRoleSchema.options.filter((role) =>
    selected.includes(role),
  )
  return {
    filters: roles.length === 1 && roles[0] ? { role: roles[0] } : undefined,
    control: (
      <SecondaryColumnFilter
        label="Role"
        options={PersonRoleSchema.options.map((value) => ({
          value,
          label: personRoleLabels[value],
        }))}
        value={roles}
        onChange={(next) => {
          view.params.delete('role')
          for (const role of next) view.params.append('role', role)
          view.replace(view.params)
        }}
      />
    ),
  }
}

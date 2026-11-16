'use client'

import { PersonPageSchema, type PersonSummary } from '@repo/schemas/creators'
import {
  CreatorLibraryDate,
  CreatorLibraryTable,
  CreatorLibraryTitle,
  type CreatorLibraryColumn,
} from './creator-library-table'
import { usePersonRoleFilter } from './person-role-filter'
import ArtistBrowser from './artist-browser'

export function ArtistsWorkspace() {
  return <ArtistBrowser />
}

export function PeopleWorkspace() {
  const roles = usePersonRoleFilter()
  const columns: CreatorLibraryColumn<PersonSummary>[] = [
    {
      key: 'name',
      label: 'Person',
      required: true,
      filter: roles.control,
      render: (person) => (
        <CreatorLibraryTitle kind="person" id={person.id} title={person.name} />
      ),
    },
    {
      key: 'filmCount',
      label: 'Films',
      className: 'numeric',
      render: (person) => person.filmCount.toLocaleString(),
    },
    {
      key: 'directorCount',
      label: 'As director',
      className: 'numeric',
      render: (person) => person.directorCount.toLocaleString(),
    },
    {
      key: 'actorCount',
      label: 'As actor',
      className: 'numeric',
      render: (person) => person.actorCount.toLocaleString(),
    },
    {
      key: 'createdAt',
      label: 'Added',
      defaultVisible: false,
      render: (person) => <CreatorLibraryDate value={person.createdAt} />,
    },
  ]
  return (
    <section className="admin-page table-workspace">
      <h1>People</h1>
      <CreatorLibraryTable
        workspace
        kind="person"
        queryKey={['people']}
        path="/api/v1/people"
        schema={PersonPageSchema}
        columns={columns}
        label="people"
        defaultSort={{ key: 'name', direction: 'asc' }}
        filters={roles.filters}
      />
    </section>
  )
}

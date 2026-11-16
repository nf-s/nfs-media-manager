'use client'

import { PersonPageSchema, type PersonSummary } from '@repo/schemas/creators'
import { PageHead } from '@repo/ui/components/ds/toolbar'
import { formatCount, formatDate } from '@repo/ui/lib/format'
import {
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
      align: 'end',
      render: (person) => formatCount(person.filmCount),
    },
    {
      key: 'directorCount',
      label: 'As director',
      align: 'end',
      render: (person) => formatCount(person.directorCount),
    },
    {
      key: 'actorCount',
      label: 'As actor',
      align: 'end',
      render: (person) => formatCount(person.actorCount),
    },
    {
      key: 'createdAt',
      label: 'Added',
      defaultVisible: false,
      render: (person) => (
        <time dateTime={person.createdAt}>{formatDate(person.createdAt)}</time>
      ),
    },
  ]
  return (
    <section className="bi-workspace" aria-label="People">
      <PageHead title="People" />
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

'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  PersonDetailSchema,
  PersonFilmPageSchema,
  type PersonDetail as Person,
} from '@repo/schemas/creators'
import type { FilmListItem } from '@repo/schemas/media'
import { Button } from '@repo/ui/components/ui/button'
import { fetchApiData } from '@/utils/api'
import { personFilmsHref, personRoleLabels } from '@/utils/creator-browse'
import { CreatorDetailState } from './creator-detail-state'
import {
  CreatorLibraryDate,
  CreatorLibraryTable,
  CreatorLibraryTitle,
  type CreatorLibraryColumn,
} from './creator-library-table'
import { usePersonRoleFilter } from './person-role-filter'
import { useConfig } from './providers'
import { DetailSourceTabs } from './detail-source-tabs'

export function PersonDetail({ id }: { id: string }) {
  const { apiBaseUrl } = useConfig()
  const path = `/api/v1/people/${encodeURIComponent(id)}`
  const query = useQuery({
    queryKey: ['person', id],
    queryFn: ({ signal }) =>
      fetchApiData(apiBaseUrl, path, PersonDetailSchema, { signal }),
  })
  if (!query.data)
    return (
      <CreatorDetailState
        pending={query.isPending}
        retry={query.refetch}
        subject="person"
      />
    )
  const person = query.data
  return (
    <article className="media-detail">
      {query.isRefetchError && (
        <CreatorDetailState stale retry={query.refetch} subject="person" />
      )}
      <header className="mb-4">
        <h1 className="mb-1 break-words text-xl font-semibold">
          {person.name}
        </h1>
        {person.roles.length > 0 && (
          <p className="detail-facts">
            {person.roles.map((role) => personRoleLabels[role]).join(' · ')}
          </p>
        )}
        <div className="form-actions mt-2">
          {person.roles.map((role) => (
            <Button key={role} asChild size="sm" variant="outline">
              <Link href={personFilmsHref(person.id, role)}>
                Filter films as {role}
              </Link>
            </Button>
          ))}
        </div>
      </header>
      <DetailSourceTabs
        label="Person details"
        overviewLabel="Films"
        sources={{
          rows: [],
          unavailable: 'No provider sources are stored for this person.',
        }}
      >
        <PersonFilms person={person} path={`${path}/films`} />
      </DetailSourceTabs>
    </article>
  )
}

function PersonFilms({ person, path }: { person: Person; path: string }) {
  const roles = usePersonRoleFilter()
  const columns: CreatorLibraryColumn<FilmListItem>[] = [
    {
      key: 'title',
      label: 'Film',
      required: true,
      filter: roles.control,
      render: (film) => (
        <CreatorLibraryTitle
          kind="film"
          id={film.id}
          title={film.title}
          context={person.roles
            .filter((role) =>
              film.credits.some(
                (credit) =>
                  credit.role === role &&
                  (credit.id === null
                    ? credit.name === person.name
                    : credit.id === person.id),
              ),
            )
            .map((role) => personRoleLabels[role])
            .join(', ')}
        />
      ),
    },
    {
      key: 'releaseDate',
      label: 'Released',
      render: (film) => <CreatorLibraryDate value={film.releaseDate} />,
    },
    {
      key: 'runtimeMinutes',
      label: 'Runtime',
      className: 'numeric',
      render: (film) =>
        film.runtimeMinutes === null ? '-' : `${film.runtimeMinutes} min`,
    },
    {
      key: 'watched',
      label: 'Watched',
      render: (film) => (film.watched ? 'Yes' : 'No'),
    },
    {
      key: 'dateAdded',
      label: 'Added',
      defaultVisible: false,
      render: (film) => <CreatorLibraryDate value={film.dateAdded} />,
    },
  ]
  return (
    <CreatorLibraryTable
      kind="film"
      queryKey={['person', person.id, 'films']}
      path={path}
      schema={PersonFilmPageSchema}
      columns={columns}
      label="films"
      defaultSort={{ key: 'title', direction: 'asc' }}
      filters={roles.filters}
    />
  )
}

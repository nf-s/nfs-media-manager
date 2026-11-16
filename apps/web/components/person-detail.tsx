'use client'

import { useQuery } from '@tanstack/react-query'
import { UserRound } from 'lucide-react'
import {
  PersonDetailSchema,
  PersonFilmPageSchema,
  type PersonDetail as Person,
} from '@repo/schemas/creators'
import type { FilmListItem } from '@repo/schemas/media'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { Section, Stats } from '@repo/ui/components/ds/facts'
import { TabsContent } from '@repo/ui/components/ui/tabs'
import { formatCount, formatRuntime } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { personFilmsHref, personRoleLabels } from '@/utils/creator-browse'
import { CreatorDetailState } from './creator-detail-state'
import { DetailMore } from './detail-more'
import {
  CreatorLibraryDate,
  CreatorLibraryTable,
  CreatorLibraryTitle,
  type CreatorLibraryColumn,
} from './creator-library-table'
import { DetailArt, DetailTabs, useDetailTab } from './detail-frame'
import { usePersonRoleFilter } from './person-role-filter'
import { ProviderSources } from './provider-sources'
import { useConfig } from './providers'

type PersonTab = 'overview' | 'sources'
const personTabs: readonly [PersonTab, ...PersonTab[]] = ['overview', 'sources']

export function PersonDetail({ id }: { id: string }) {
  const { apiBaseUrl } = useConfig()
  const { tab, setTab } = useDetailTab(personTabs, {
    aliases: { films: 'overview' },
  })
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
    <article className="dtl-detail">
      {query.isRefetchError && (
        <CreatorDetailState stale retry={query.refetch} subject="person" />
      )}
      <DetailHeader
        art={
          <DetailArt
            src={null}
            ratio="round"
            fallback={<UserRound className="ds-i" aria-hidden="true" />}
          />
        }
        kind="Person"
        title={person.name}
        facts={[
          person.roles.map((role) => personRoleLabels[role]).join(', '),
          `${formatCount(person.filmCount)} ${person.filmCount === 1 ? 'film' : 'films'}`,
        ]}
        actions={
          <>
            <DetailActionsSpacer />
            <DetailMore
              crumb={{ title: person.name }}
              items={person.roles.map((role) => ({
                label: `Filter films as ${personRoleLabels[role].toLowerCase()}`,
                href: personFilmsHref(person.id, role),
              }))}
            />
          </>
        }
      />
      <DetailTabs
        label="Person details"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'sources', label: 'Sources' },
        ]}
      >
        <TabsContent value="overview">
          <Section flush>
            <Stats
              items={[
                { label: 'films', value: formatCount(person.filmCount) },
                {
                  label: 'as director',
                  value: formatCount(person.directorCount),
                },
                { label: 'as actor', value: formatCount(person.actorCount) },
              ]}
            />
          </Section>
          <Section title="Films" note={formatCount(person.filmCount)}>
            <PersonFilms person={person} path={`${path}/films`} />
          </Section>
        </TabsContent>
        <TabsContent value="sources">
          <ProviderSources
            rows={[]}
            unavailable="No provider sources are stored for this person."
          />
        </TabsContent>
      </DetailTabs>
    </article>
  )
}

function PersonFilms({ person, path }: { person: Person; path: string }) {
  const roles = usePersonRoleFilter()
  function creditRoles(film: FilmListItem) {
    return person.roles
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
      .join(', ')
  }
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
          context={creditRoles(film)}
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
      align: 'end',
      render: (film) => formatRuntime(film.runtimeMinutes),
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
      card={(film) => ({
        title: film.title,
        artworkUrl: film.artworkUrl,
        subtitle: creditRoles(film),
        metadata: [
          film.releaseDate?.slice(0, 4),
          film.runtimeMinutes === null
            ? undefined
            : formatRuntime(film.runtimeMinutes),
          film.watched ? 'Watched' : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
      })}
      label="films"
      defaultSort={{ key: 'title', direction: 'asc' }}
      filters={roles.filters}
      filterPanel={roles.filterPanel}
    />
  )
}

'use client'

import { useQuery } from '@tanstack/react-query'
import { UserRound } from 'lucide-react'
import {
  PersonDetailSchema,
  type PersonDetail as Person,
} from '@repo/schemas/creators'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { Section, Stats } from '@repo/ui/components/ds/facts'
import { TabsContent } from '@repo/ui/components/ui/tabs'
import { formatCount } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { personFilmsHref, personRoleLabels } from '@/utils/creator-browse'
import { CreatorDetailState } from './creator-detail-state'
import { DetailMore } from './detail-more'
import { DetailArt, DetailTabs, useDetailTab } from './detail-frame'
import { EmbeddedMediaBrowser } from './media-browser'
import { usePersonRoleFilter } from './person-role-filter'
import { ProviderSources } from './provider-sources'
import { CatalogDiscoveries, CatalogLibraryAction } from './catalog-detail'
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
          person.inLibrary === false ? 'Outside library' : null,
        ]}
        actions={
          <>
            <CatalogLibraryAction
              kind="person"
              id={person.id}
              title={person.name}
              inLibrary={person.inLibrary !== false}
            />
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
            <PersonFilms person={person} />
          </Section>
        </TabsContent>
        <TabsContent value="sources">
          <CatalogDiscoveries kind="person" id={person.id} />
          <ProviderSources
            rows={[]}
            unavailable="No provider sources are stored for this person."
          />
        </TabsContent>
      </DetailTabs>
    </article>
  )
}

/** The person's films; the role control holds them to one credit role. */
function PersonFilms({ person }: { person: Person }) {
  const roles = usePersonRoleFilter()
  return (
    <EmbeddedMediaBrowser
      mediaType="film"
      creator={{
        creatorId: person.id,
        ...(roles.filters ? { creatorRole: roles.filters.role } : {}),
      }}
      storage="person-films"
      sort={{ key: 'title', direction: 'asc' }}
      filterPanel={roles.filterPanel}
    />
  )
}

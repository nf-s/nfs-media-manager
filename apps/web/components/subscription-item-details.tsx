'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import type { BrowseFilter } from '@repo/schemas/browse'
import {
  SubscriptionItemPatchSchema,
  SubscriptionItemSchema,
  subscriptionLibraryLabels,
  subscriptionLibraryOf,
  subscriptionTypeLabels,
  type SubscriptionItem,
  type SubscriptionLibrary,
} from '@repo/schemas/subscriptions'
import { Radio, Tv } from 'lucide-react'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { Facts, Section, Stats } from '@repo/ui/components/ds/facts'
import { Pill, PillLabel } from '@repo/ui/components/ds/pill'
import { TabsContent } from '@repo/ui/components/ui/tabs'
import { EMPTY_VALUE, formatCount, formatDate } from '@repo/ui/lib/format'
import { DetailLink } from './detail-link'
import { CreatorDetailState } from './creator-detail-state'
import { DetailMore } from './detail-more'
import { WatchedToggle } from './watched-button'
import {
  DetailArt,
  DetailTabs,
  FilterPill,
  OpenAtProvider,
  useDetailTab,
} from './detail-frame'
import { ProviderSources } from './provider-sources'
import { formatCount as formatYoutubeCount } from '@/utils/youtube'
import {
  formatSubscriptionDuration,
  formatSubscriptionPublished,
  subscriptionArtworkUrl,
  subscriptionLibraryPages,
  subscriptionsHref,
  subscriptionTypeFilter,
} from '@/utils/subscriptions'
import type { BrowseFilterHref } from '@/utils/browse-items'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'
import ServiceIconLinks from './service-icon-links'

type ItemTab = 'overview' | 'sources'
const itemTabs: readonly [ItemTab, ...ItemTab[]] = ['overview', 'sources']

/** A video or episode in Subscriptions, or a mix in Mixes. */
export function SubscriptionItemDetails({
  id,
  library = 'subscriptions',
  initialItem,
  onFilter,
  filterHref = (filter) => subscriptionsHref([filter], library),
}: {
  id: string
  library?: SubscriptionLibrary
  initialItem?: SubscriptionItem
  onFilter?: (filter: BrowseFilter) => void
  filterHref?: BrowseFilterHref
}) {
  const { apiBaseUrl } = useConfig()
  const router = useRouter()
  const mixes = library === 'mixes'
  const query = useQuery({
    queryKey: [subscriptionLibraryPages[library].collection, 'item', id],
    // A browse row has no library artists; a mix is read on its own for them.
    initialData: mixes ? undefined : initialItem,
    placeholderData: mixes ? initialItem : undefined,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/subscriptions/${encodeURIComponent(id)}`,
        SubscriptionItemSchema,
        { signal },
      ),
  })
  if (query.data)
    return (
      <ItemDetails
        item={query.data}
        filterHref={filterHref}
        onFilter={
          onFilter ??
          ((filter) => router.push(subscriptionsHref([filter], library)))
        }
      />
    )
  return (
    <CreatorDetailState
      pending={!query.isError}
      retry={() => query.refetch()}
      subject={mixes ? 'mix' : 'item'}
    />
  )
}

/** Marks a video, episode or mix watched (listened) now, or not, from its header. */
function WatchedButton({ item }: { item: SubscriptionItem }) {
  const library = subscriptionLibraryOf(item.type)
  const collection = subscriptionLibraryPages[library].collection
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const watched = item.watchedAt !== null
  const mutation = useMutation({
    mutationFn: (watchedAt: string | null) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/subscriptions/${encodeURIComponent(item.id)}`,
        SubscriptionItemSchema,
        {
          method: 'PATCH',
          body: JSON.stringify(
            SubscriptionItemPatchSchema.parse({ watchedAt }),
          ),
        },
      ),
    onSuccess: (updated) => {
      client.setQueryData([collection, 'item', item.id], updated)
      return client.invalidateQueries({ queryKey: [collection] })
    },
  })
  return (
    <WatchedToggle
      label={subscriptionLibraryLabels[library].watched}
      watched={watched}
      pending={mutation.isPending}
      error={mutation.isError}
      onToggle={() =>
        mutation.mutate(watched ? null : new Date().toISOString())
      }
    />
  )
}

function ItemDetails({
  item,
  onFilter,
  filterHref,
}: {
  item: SubscriptionItem
  onFilter: (filter: BrowseFilter) => void
  filterHref: BrowseFilterHref
}) {
  const { tab, setTab } = useDetailTab(itemTabs)
  if (item.type !== 'youtube' && item.type !== 'spotify')
    return (
      <MixDetails
        item={item}
        onFilter={onFilter}
        filterHref={filterHref}
        tab={tab}
        setTab={setTab}
      />
    )
  const typeLabel = subscriptionTypeLabels[item.type]
  const provider = item.type === 'youtube' ? 'YouTube' : 'Spotify'
  const itemLink = { provider: item.type, label: provider, url: item.url }
  const duration = formatSubscriptionDuration(item)
  const published = (
    <time dateTime={item.publishedAt}>
      {formatSubscriptionPublished(item.publishedAt, item.publishedPrecision, {
        detail: true,
      })}
    </time>
  )
  return (
    <article className="dtl-detail">
      <DetailHeader
        art={
          <DetailArt
            src={subscriptionArtworkUrl(item)}
            ratio="video"
            badge={duration !== '-' ? duration : undefined}
            fallback={<Tv className="ds-i" aria-hidden="true" />}
          />
        }
        kind={item.type === 'youtube' ? 'Video' : 'Episode'}
        title={item.title}
        by={
          <>
            from{' '}
            <DetailLink kind="channel" id={item.sourceId}>
              {item.sourceTitle}
            </DetailLink>
          </>
        }
        facts={[
          typeLabel,
          published,
          duration !== '-' ? duration : null,
          item.type === 'youtube' && item.viewCount !== null
            ? `${formatCount(item.viewCount)} views`
            : null,
          item.watchedAt ? `Watched ${formatDate(item.watchedAt)}` : null,
        ]}
        links={
          <ServiceIconLinks
            links={[
              {
                provider: item.type === 'youtube' ? 'youtube' : 'spotify',
                label: provider,
                url: item.url,
              },
            ]}
            itemTitle={item.title}
          />
        }
        actions={
          <>
            <WatchedButton item={item} />
            <DetailActionsSpacer />
            <DetailMore crumb={{ title: item.title }} />
          </>
        }
      />
      <DetailTabs
        label="Subscription details"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'sources', label: 'Sources' },
        ]}
      >
        <TabsContent value="overview">
          {item.type === 'youtube' && (
            <Section flush>
              <Stats
                items={[
                  { label: 'views', value: formatYoutubeCount(item.viewCount) },
                  { label: 'likes', value: formatYoutubeCount(item.likeCount) },
                  {
                    label: 'comments',
                    value: formatYoutubeCount(item.commentCount),
                  },
                ]}
              />
            </Section>
          )}
          {item.description && (
            <Section title="About">
              <p className="dtl-text">{item.description}</p>
            </Section>
          )}
          {item.tags.length > 0 && (
            <Section title="Tags">
              <span
                className="ds-pills"
                data-wrap=""
                role="group"
                aria-label="Tags"
              >
                {item.tags.map((tag) => (
                  <FilterPill
                    key={tag}
                    label={tag}
                    workspaceHref={filterHref({ field: 'genre', value: tag })}
                    title={`Filter Tags: ${tag}`}
                    onClick={() => onFilter({ field: 'genre', value: tag })}
                  />
                ))}
              </span>
            </Section>
          )}
          <Section title="Details">
            <Facts
              items={[
                {
                  label: 'Type',
                  value: (
                    <FilterPill
                      label={typeLabel}
                      title={`Filter Type: ${typeLabel}`}
                      onClick={() =>
                        onFilter(subscriptionTypeFilter(item.type))
                      }
                    />
                  ),
                },
                { label: 'Published', value: published },
                {
                  label: 'Duration',
                  value: duration !== '-' ? duration : EMPTY_VALUE,
                },
              ]}
            />
          </Section>
        </TabsContent>
        <TabsContent value="sources">
          <ProviderSources
            rows={[
              {
                id: item.type,
                label: provider,
                identifier: item.id,
                links: [itemLink],
              },
            ]}
          />
        </TabsContent>
      </DetailTabs>
    </article>
  )
}

type MixItem = Extract<SubscriptionItem, { artists: string[] }>

/** A billed name opens its library artist when there is one, and otherwise filters Mixes. */
function MixArtistPill({
  name,
  item,
  onFilter,
  filterHref,
}: {
  name: string
  item: MixItem
  onFilter: (filter: BrowseFilter) => void
  filterHref: BrowseFilterHref
}) {
  const key = name.toLocaleLowerCase()
  const artist = item.libraryArtists.find(
    (candidate) => candidate.name.toLocaleLowerCase() === key,
  )
  if (artist)
    return (
      <Pill asChild size="md">
        <DetailLink kind="artist" id={artist.id} title={`Open ${artist.name}`}>
          <PillLabel>{name}</PillLabel>
        </DetailLink>
      </Pill>
    )
  return (
    <FilterPill
      label={name}
      title={`Filter Artist: ${name}`}
      workspaceHref={filterHref({ field: 'artist', value: name })}
      onClick={() => onFilter({ field: 'artist', value: name })}
    />
  )
}

/** A station mix: links out to the station and the recording; no player. */
function MixDetails({
  item,
  onFilter,
  filterHref,
  tab,
  setTab,
}: {
  item: MixItem
  onFilter: (filter: BrowseFilter) => void
  filterHref: BrowseFilterHref
  tab: ItemTab
  setTab: (tab: string) => void
}) {
  const station = subscriptionTypeLabels[item.type]
  const duration = formatSubscriptionDuration(item)
  const known = duration !== EMPTY_VALUE
  const broadcast = (
    <time dateTime={item.publishedAt}>
      {formatSubscriptionPublished(item.publishedAt, item.publishedPrecision, {
        detail: true,
      })}
    </time>
  )
  const show = (
    <DetailLink kind="show" id={item.sourceId}>
      {item.sourceTitle}
    </DetailLink>
  )
  return (
    <article className="dtl-detail">
      <DetailHeader
        art={
          <DetailArt
            src={subscriptionArtworkUrl(item)}
            fallback={<Radio className="ds-i" aria-hidden="true" />}
          />
        }
        kind="Mix"
        title={item.title}
        by={<>from {show}</>}
        facts={[
          station,
          broadcast,
          known ? duration : null,
          item.watchedAt ? `Listened ${formatDate(item.watchedAt)}` : null,
        ]}
        links={
          <ServiceIconLinks
            links={[{ provider: station, label: station, url: item.url }]}
            itemTitle={item.title}
          />
        }
        actions={
          <>
            <WatchedButton item={item} />
            <DetailActionsSpacer />
            {item.audioUrl && (
              <OpenAtProvider
                label={station}
                actionLabel="Open recording"
                url={item.audioUrl}
              />
            )}
            <DetailMore crumb={{ title: item.title }} />
          </>
        }
      />
      <DetailTabs
        label="Mix details"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'sources', label: 'Sources' },
        ]}
      >
        <TabsContent value="overview">
          {item.artists.length > 0 && (
            <Section title="Artists" flush>
              <span
                className="ds-pills"
                data-wrap=""
                role="group"
                aria-label="Artists"
              >
                {item.artists.map((name) => (
                  <MixArtistPill
                    key={name}
                    name={name}
                    item={item}
                    onFilter={onFilter}
                    filterHref={filterHref}
                  />
                ))}
              </span>
            </Section>
          )}
          {item.tags.length > 0 && (
            <Section title="Tags" flush={item.artists.length === 0}>
              <span
                className="ds-pills"
                data-wrap=""
                role="group"
                aria-label="Tags"
              >
                {item.tags.map((tag) => (
                  <FilterPill
                    key={tag}
                    label={tag}
                    workspaceHref={filterHref({ field: 'genre', value: tag })}
                    title={`Filter Tags: ${tag}`}
                    onClick={() => onFilter({ field: 'genre', value: tag })}
                  />
                ))}
              </span>
            </Section>
          )}
          <Section
            title="Details"
            flush={item.artists.length === 0 && item.tags.length === 0}
          >
            <Facts
              items={[
                {
                  label: 'Station',
                  value: (
                    <FilterPill
                      label={station}
                      workspaceHref={filterHref(
                        subscriptionTypeFilter(item.type),
                      )}
                      title={`Filter Station: ${station}`}
                      onClick={() =>
                        onFilter(subscriptionTypeFilter(item.type))
                      }
                    />
                  ),
                },
                { label: 'Show', value: show },
                { label: 'Broadcast', value: broadcast },
                { label: 'Duration', value: duration },
              ]}
            />
          </Section>
          {item.description && (
            <Section title="About">
              {/* Line breaks are kept: a station may list the tracks here, one per line. */}
              <p className="dtl-text">{item.description}</p>
            </Section>
          )}
        </TabsContent>
        <TabsContent value="sources">
          <ProviderSources
            rows={[
              {
                id: item.type,
                label: station,
                identifier: item.id,
                links: [{ provider: item.type, label: station, url: item.url }],
              },
            ]}
          />
        </TabsContent>
      </DetailTabs>
    </article>
  )
}

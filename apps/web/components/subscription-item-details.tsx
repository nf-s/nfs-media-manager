'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import type { BrowseFilter } from '@repo/schemas/browse'
import {
  SubscriptionItemPatchSchema,
  SubscriptionItemSchema,
  subscriptionTypeLabels,
  type SubscriptionItem,
} from '@repo/schemas/subscriptions'
import { Tv } from 'lucide-react'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { Facts, Section, Stats } from '@repo/ui/components/ds/facts'
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
  subscriptionsHref,
  subscriptionTypeFilter,
} from '@/utils/subscriptions'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'

type ItemTab = 'overview' | 'sources'
const itemTabs: readonly [ItemTab, ...ItemTab[]] = ['overview', 'sources']

export function SubscriptionItemDetails({
  id,
  initialItem,
  onFilter,
}: {
  id: string
  initialItem?: SubscriptionItem
  onFilter?: (filter: BrowseFilter) => void
}) {
  const { apiBaseUrl } = useConfig()
  const router = useRouter()
  const query = useQuery({
    queryKey: ['subscriptions', 'item', id],
    initialData: initialItem,
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
        onFilter={
          onFilter ?? ((filter) => router.push(subscriptionsHref([filter])))
        }
      />
    )
  return (
    <CreatorDetailState
      pending={!query.isError}
      retry={() => query.refetch()}
      subject="item"
    />
  )
}

/** Marks a video or episode watched now, or unwatched, from its header. */
function WatchedButton({ item }: { item: SubscriptionItem }) {
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
      client.setQueryData(['subscriptions', 'item', item.id], updated)
      return client.invalidateQueries({ queryKey: ['subscriptions'] })
    },
  })
  return (
    <WatchedToggle
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
}: {
  item: SubscriptionItem
  onFilter: (filter: BrowseFilter) => void
}) {
  const { tab, setTab } = useDetailTab(itemTabs)
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
        actions={
          <>
            <WatchedButton item={item} />
            <DetailActionsSpacer />
            <OpenAtProvider label={provider} url={item.url} />
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

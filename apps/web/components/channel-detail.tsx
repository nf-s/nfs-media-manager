'use client'

import Link from 'next/link'
import { Tv } from 'lucide-react'
import {
  SubscriptionSourceDetailSchema,
  subscriptionTypeLabels,
  type SubscriptionItem,
} from '@repo/schemas/subscriptions'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { Section } from '@repo/ui/components/ds/facts'
import { Button } from '@repo/ui/components/ui/button'
import { TabsContent } from '@repo/ui/components/ui/tabs'
import { EMPTY_VALUE, formatCount } from '@repo/ui/lib/format'
import { useSubscriptionSource } from '@/hooks/useSubscriptionSource'
import {
  formatSubscriptionDuration,
  formatSubscriptionPublished,
  formatSubscriptionSourceSize,
  subscriptionArtworkUrl,
  subscriptionSourceHref,
} from '@/utils/subscriptions'
import { CreatorDetailState } from './creator-detail-state'
import {
  CreatorLibraryTable,
  CreatorLibraryTitle,
  type CreatorLibraryColumn,
} from './creator-library-table'
import {
  DetailArt,
  DetailTabs,
  OpenAtProvider,
  useDetailTab,
} from './detail-frame'
import { ProviderSources } from './provider-sources'

type ChannelTab = 'overview' | 'sources'
const channelTabs: readonly [ChannelTab, ...ChannelTab[]] = [
  'overview',
  'sources',
]

const itemPageSchema = SubscriptionSourceDetailSchema.transform(
  ({ items }) => items,
)
const itemColumns: CreatorLibraryColumn<SubscriptionItem>[] = [
  {
    key: 'title',
    label: 'Title',
    required: true,
    render: (item) => (
      <CreatorLibraryTitle
        kind="subscription"
        id={item.id}
        title={item.title}
      />
    ),
  },
  {
    key: 'publishedAt',
    label: 'Published',
    className: 'whitespace-nowrap',
    render: (item) => (
      <time dateTime={item.publishedAt}>
        {formatSubscriptionPublished(item.publishedAt, item.publishedPrecision)}
      </time>
    ),
  },
  {
    key: 'durationSec',
    label: 'Duration',
    align: 'end',
    render: formatSubscriptionDuration,
  },
]
const videoColumns: CreatorLibraryColumn<SubscriptionItem>[] = [
  ...itemColumns,
  {
    key: 'viewCount',
    label: 'Views',
    align: 'end',
    render: (item) =>
      item.type === 'youtube' && item.viewCount !== null
        ? formatCount(item.viewCount)
        : EMPTY_VALUE,
  },
]

export function ChannelDetail({ id }: { id: string }) {
  const path = `/api/v1/subscriptions/sources/${encodeURIComponent(id)}`
  const { tab, setTab } = useDetailTab(channelTabs, {
    aliases: { videos: 'overview', episodes: 'overview' },
  })
  const query = useSubscriptionSource(id)
  if (!query.data)
    return (
      <CreatorDetailState
        pending={query.isPending}
        retry={query.refetch}
        subject="channel"
      />
    )
  const { source } = query.data
  const isVideo = source.type === 'youtube'
  const sourceLink = {
    provider: source.type,
    label: isVideo ? 'YouTube channel' : 'Spotify show',
    url: source.url,
  }
  return (
    <article className="dtl-detail">
      {query.isRefetchError && (
        <CreatorDetailState stale retry={query.refetch} subject="channel" />
      )}
      <DetailHeader
        art={
          <DetailArt
            src={source.thumbnailUrl}
            ratio="round"
            fallback={<Tv className="ds-i" aria-hidden="true" />}
          />
        }
        kind="Channel"
        title={source.title}
        facts={[
          subscriptionTypeLabels[source.type],
          source.type === 'youtube' ? source.handle : null,
          formatSubscriptionSourceSize(source),
          source.historyComplete ? null : 'Reading history',
        ]}
        actions={
          <>
            <Button asChild size="md">
              <Link href={subscriptionSourceHref(source.id)}>
                Filter subscriptions
              </Link>
            </Button>
            <DetailActionsSpacer />
            <OpenAtProvider
              label={isVideo ? 'YouTube' : 'Spotify'}
              url={source.url}
            />
          </>
        }
      />
      <DetailTabs
        label="Channel details"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'sources', label: 'Sources' },
        ]}
      >
        <TabsContent value="overview">
          {source.description && (
            <Section title="About" flush>
              <p className="dtl-text">{source.description}</p>
            </Section>
          )}
          <Section title={isVideo ? 'Videos' : 'Episodes'}>
            <CreatorLibraryTable
              kind="subscription"
              queryKey={['subscriptions', 'source', id, 'items']}
              path={path}
              schema={itemPageSchema}
              columns={isVideo ? videoColumns : itemColumns}
              card={(item) => ({
                title: item.title,
                artworkUrl: subscriptionArtworkUrl(item),
                subtitle: formatSubscriptionPublished(
                  item.publishedAt,
                  item.publishedPrecision,
                ),
                metadata:
                  item.durationSec !== null ||
                  (item.type === 'youtube' && item.live !== 'none')
                    ? formatSubscriptionDuration(item)
                    : undefined,
              })}
              label={isVideo ? 'videos' : 'episodes'}
              defaultSort={{ key: 'publishedAt', direction: 'desc' }}
            />
          </Section>
        </TabsContent>
        <TabsContent value="sources">
          <ProviderSources
            rows={[
              {
                id: source.type,
                label: isVideo ? 'YouTube' : 'Spotify',
                identifier: source.id,
                links: [sourceLink],
              },
            ]}
          />
        </TabsContent>
      </DetailTabs>
    </article>
  )
}

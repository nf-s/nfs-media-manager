'use client'

import { Check, Radio, Tv } from 'lucide-react'
import {
  SubscriptionSourceDetailSchema,
  subscriptionLibraryLabels,
  type SubscriptionSourceDetail,
  subscriptionTypeLabels,
  type SubscriptionItem,
  type SubscriptionLibrary,
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
  subscriptionLibraryPages,
  subscriptionSourceHref,
} from '@/utils/subscriptions'
import { CreatorDetailState } from './creator-detail-state'
import { DetailMore } from './detail-more'
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
function libraryItemColumns(
  library: SubscriptionLibrary,
): CreatorLibraryColumn<SubscriptionItem>[] {
  return [
    {
      key: 'title',
      label: 'Title',
      required: true,
      render: (item) => (
        <CreatorLibraryTitle
          kind={subscriptionLibraryPages[library].itemKind}
          id={item.id}
          title={item.title}
        />
      ),
    },
    {
      key: 'publishedAt',
      label: subscriptionLibraryLabels[library].published,
      className: 'whitespace-nowrap',
      render: (item) => (
        <time dateTime={item.publishedAt}>
          {formatSubscriptionPublished(
            item.publishedAt,
            item.publishedPrecision,
          )}
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
}
const itemColumns = libraryItemColumns('subscriptions')
const mixColumns = libraryItemColumns('mixes')
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

/** A channel or podcast in Subscriptions, or a station's show in Mixes. */
export function ChannelDetail({
  id,
  library = 'subscriptions',
}: {
  id: string
  library?: SubscriptionLibrary
}) {
  const path = `/api/v1/subscriptions/sources/${encodeURIComponent(id)}`
  const { tab, setTab } = useDetailTab(channelTabs, {
    aliases: { videos: 'overview', episodes: 'overview' },
  })
  const query = useSubscriptionSource(id, library)
  const page = subscriptionLibraryPages[library]
  if (!query.data)
    return (
      <CreatorDetailState
        pending={query.isPending}
        retry={query.refetch}
        subject={page.sources.one}
      />
    )
  const { source } = query.data
  if (library === 'mixes')
    return (
      <ShowDetail
        id={id}
        path={path}
        source={source}
        tab={tab}
        setTab={setTab}
        stale={query.isRefetchError}
        retry={query.refetch}
      />
    )
  const isVideo = source.type === 'youtube'
  const sourceLink = {
    provider: source.type,
    label: isVideo ? 'YouTube channel' : 'Spotify show',
    url: source.url,
  }
  // Sync follows the account; the app has no way to unsubscribe one source.
  const subscribedNote = `channel-subscribed-${source.id}`
  const subscribedHelp = `Follows the connected ${isVideo ? 'YouTube' : 'Spotify'} account. Change it there.`
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
            <Button
              type="button"
              size="md"
              aria-pressed="true"
              aria-describedby={subscribedNote}
              title={subscribedHelp}
            >
              <Check className="ds-i" data-size="sm" aria-hidden="true" />
              Subscribed
            </Button>
            <span id={subscribedNote} className="sr-only">
              {subscribedHelp}
            </span>
            <DetailActionsSpacer />
            <OpenAtProvider
              label={isVideo ? 'YouTube' : 'Spotify'}
              url={source.url}
            />
            <DetailMore
              crumb={{ title: source.title }}
              items={[
                {
                  label: 'Filter subscriptions',
                  href: subscriptionSourceHref(source.id),
                },
              ]}
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

/** A station show: no subscription to show, mixes listed square like albums. */
function ShowDetail({
  id,
  path,
  source,
  tab,
  setTab,
  stale,
  retry,
}: {
  id: string
  path: string
  source: SubscriptionSourceDetail['source']
  tab: ChannelTab
  setTab: (tab: string) => void
  stale: boolean
  retry: () => void
}) {
  const station = subscriptionTypeLabels[source.type]
  return (
    <article className="dtl-detail">
      {stale && <CreatorDetailState stale retry={retry} subject="show" />}
      <DetailHeader
        art={
          <DetailArt
            src={source.thumbnailUrl}
            fallback={<Radio className="ds-i" aria-hidden="true" />}
          />
        }
        kind="Show"
        title={source.title}
        facts={[
          station,
          formatSubscriptionSourceSize(source),
          source.historyComplete ? null : 'Reading history',
        ]}
        actions={
          <>
            <DetailActionsSpacer />
            <OpenAtProvider
              label={station}
              actionLabel={`Open on ${station}`}
              url={source.url}
            />
            <DetailMore
              crumb={{ title: source.title }}
              items={[
                {
                  label: 'Filter mixes',
                  href: subscriptionSourceHref(source.id, 'mixes'),
                },
              ]}
            />
          </>
        }
      />
      <DetailTabs
        label="Show details"
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
          <Section title="Mixes">
            <CreatorLibraryTable
              kind="mix"
              queryKey={['mixes', 'source', id, 'items']}
              path={path}
              schema={itemPageSchema}
              columns={mixColumns}
              card={(item) => ({
                title: item.title,
                artworkUrl: subscriptionArtworkUrl(item),
                subtitle: formatSubscriptionPublished(
                  item.publishedAt,
                  item.publishedPrecision,
                ),
                metadata:
                  item.durationSec === null
                    ? undefined
                    : formatSubscriptionDuration(item),
              })}
              label="mixes"
              defaultSort={{ key: 'publishedAt', direction: 'desc' }}
            />
          </Section>
        </TabsContent>
        <TabsContent value="sources">
          <ProviderSources
            rows={[
              {
                id: source.type,
                label: station,
                identifier: source.id,
                links: [
                  { provider: source.type, label: station, url: source.url },
                ],
              },
            ]}
          />
        </TabsContent>
      </DetailTabs>
    </article>
  )
}

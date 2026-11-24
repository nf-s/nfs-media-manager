'use client'

import { Check, Radio, Tv } from 'lucide-react'
import {
  type SubscriptionSourceDetail,
  subscriptionTypeLabels,
  type SubscriptionLibrary,
} from '@repo/schemas/subscriptions'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { Section } from '@repo/ui/components/ds/facts'
import { Button } from '@repo/ui/components/ui/button'
import { TabsContent } from '@repo/ui/components/ui/tabs'
import { useSubscriptionSource } from '@/hooks/useSubscriptionSource'
import { browseStateKeys } from '@/utils/embedded-browse'
import {
  formatSubscriptionSourceSize,
  subscriptionLibraryPages,
  subscriptionSourceHref,
} from '@/utils/subscriptions'
import { CreatorDetailState } from './creator-detail-state'
import { DetailMore } from './detail-more'
import { DetailArt, DetailTabs, useDetailTab } from './detail-frame'
import { ProviderSources } from './provider-sources'
import { CatalogDiscoveries, CatalogLibraryAction } from './catalog-detail'
import { EmbeddedSubscriptionBrowser } from './subscription-browser'
import ServiceIconLinks from './service-icon-links'

type ChannelTab = 'overview' | 'sources'
const channelTabs: readonly [ChannelTab, ...ChannelTab[]] = [
  'overview',
  'sources',
]

/** A channel or podcast in Subscriptions, or a station's show in Mixes. */
export function ChannelDetail({
  id,
  library = 'subscriptions',
}: {
  id: string
  library?: SubscriptionLibrary
}) {
  const { tab, setTab } = useDetailTab(channelTabs, {
    aliases: { videos: 'overview', episodes: 'overview' },
    // The list's search, filters, sort and view belong to the Overview tab.
    reset: browseStateKeys,
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
          source.inLibrary === false ? 'Outside library' : null,
        ]}
        links={
          <ServiceIconLinks
            links={[
              {
                provider: isVideo ? 'youtube' : 'spotify',
                label: isVideo ? 'YouTube' : 'Spotify',
                url: source.url,
              },
            ]}
            itemTitle={source.title}
          />
        }
        actions={
          <>
            {source.subscribed !== false && (
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
              </>
            )}
            <CatalogLibraryAction
              kind="subscription-source"
              id={source.id}
              title={source.title}
              inLibrary={source.inLibrary !== false}
            />
            <DetailActionsSpacer />
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
        reset={browseStateKeys}
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
            <EmbeddedSubscriptionBrowser
              library="subscriptions"
              sourceId={id}
              storage="channel-items"
              sort={{ key: 'publishedAt', direction: 'desc' }}
            />
          </Section>
        </TabsContent>
        <TabsContent value="sources">
          <CatalogDiscoveries kind="subscription-source" id={source.id} />
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
  source,
  tab,
  setTab,
  stale,
  retry,
}: {
  id: string
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
          source.inLibrary === false ? 'Outside library' : null,
        ]}
        links={
          <ServiceIconLinks
            links={[{ provider: station, label: station, url: source.url }]}
            itemTitle={source.title}
          />
        }
        actions={
          <>
            <CatalogLibraryAction
              kind="subscription-source"
              id={source.id}
              title={source.title}
              inLibrary={source.inLibrary !== false}
            />
            <DetailActionsSpacer />
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
        reset={browseStateKeys}
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
            <EmbeddedSubscriptionBrowser
              library="mixes"
              sourceId={id}
              storage="show-mixes"
              sort={{ key: 'publishedAt', direction: 'desc' }}
            />
          </Section>
        </TabsContent>
        <TabsContent value="sources">
          <CatalogDiscoveries kind="subscription-source" id={source.id} />
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

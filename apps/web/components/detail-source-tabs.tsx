'use client'

import type { ComponentProps, ReactNode } from 'react'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@repo/ui/components/ui/tabs'
import { useDetailView } from './detail-inspector-context'
import { ProviderSources } from './provider-sources'

export function DetailSourceTabs({
  label,
  overviewLabel,
  sources,
  overviewClassName,
  children,
}: {
  label: string
  overviewLabel: string
  sources: Pick<
    ComponentProps<typeof ProviderSources>,
    'rows' | 'pending' | 'unavailable' | 'onRetry'
  >
  overviewClassName?: string
  children: ReactNode
}) {
  const { params, replace } = useDetailView()
  const tab = params.get('tab') === 'sources' ? 'sources' : 'overview'
  return (
    <Tabs
      className="flex min-h-0 flex-1 flex-col"
      value={tab}
      onValueChange={(value) => {
        if (value === 'sources') params.set('tab', value)
        else params.delete('tab')
        replace(params)
      }}
    >
      <TabsList aria-label={label} className="shrink-0 self-start">
        <TabsTrigger value="overview">{overviewLabel}</TabsTrigger>
        <TabsTrigger value="sources">Sources</TabsTrigger>
      </TabsList>
      <TabsContent
        value="overview"
        className={`mt-3 min-h-0 data-[state=inactive]:hidden ${overviewClassName ?? ''}`}
      >
        {children}
      </TabsContent>
      <TabsContent value="sources" className="mt-3 min-h-0 overflow-auto">
        <ProviderSources {...sources} />
      </TabsContent>
    </Tabs>
  )
}

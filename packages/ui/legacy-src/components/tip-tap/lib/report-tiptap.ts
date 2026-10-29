import Highlight from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import TextAlign from '@tiptap/extension-text-align'
import Typography from '@tiptap/extension-typography'
import StarterKit from '@tiptap/starter-kit'
import { chartNodeCoreExtension } from '@repo/ui/components/tip-tap/node/chart-node/chart-node-core'
import type { AnyExtension, Extensions } from '@tiptap/react'

export type ReportTiptapExtensionsOptions = {
  chartNodeExtension?: AnyExtension
  horizontalRuleExtension?: AnyExtension
  extraExtensions?: Extensions
}

export const getReportTiptapExtensions = ({
  chartNodeExtension = chartNodeCoreExtension,
  horizontalRuleExtension,
  extraExtensions = [],
}: ReportTiptapExtensionsOptions = {}): Extensions => [
  StarterKit.configure({
    horizontalRule: horizontalRuleExtension ? false : undefined,
    link: {
      openOnClick: false,
      enableClickSelection: true,
    },
  }),
  ...(horizontalRuleExtension ? [horizontalRuleExtension] : []),
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Highlight.configure({ multicolor: true }),
  Typography,
  Superscript,
  Subscript,
  chartNodeExtension,
  ...extraExtensions,
]

'use client'

import {
  Content,
  EditorContent,
  EditorContext,
  Extensions,
  useEditor,
} from '@tiptap/react'
import * as React from 'react'

// --- Tiptap Core Extensions ---
import DragHandle from '@tiptap/extension-drag-handle-react'
import '@tiptap/extension-text-align'
import { getReportTiptapExtensions } from '@repo/ui/components/tip-tap/lib/report-tiptap'
import { Selection } from '@tiptap/extensions'
import '@tiptap/starter-kit'

// --- UI Primitives ---
import { Button } from '@repo/ui/components/tip-tap/ui-primitive/button'
import { Spacer } from '@repo/ui/components/tip-tap/ui-primitive/spacer'
import {
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
} from '@repo/ui/components/tip-tap/ui-primitive/toolbar'

// --- Tiptap Node ---
import '@repo/ui/components/tip-tap/node/blockquote-node/blockquote-node.scss'
import { ChartNode } from '@repo/ui/components/tip-tap/node/chart-node/chart-node-extension'
import type { ChartFormBuilder } from '@repo/ui/components/tip-tap/node/chart-node/chart-node-shared'
import '@repo/ui/components/tip-tap/node/chart-node/chart-node.scss'
import '@repo/ui/components/tip-tap/node/code-block-node/code-block-node.scss'
import '@repo/ui/components/tip-tap/node/heading-node/heading-node.scss'
import { HorizontalRule } from '@repo/ui/components/tip-tap/node/horizontal-rule-node/horizontal-rule-node-extension'
import '@repo/ui/components/tip-tap/node/horizontal-rule-node/horizontal-rule-node.scss'
import '@repo/ui/components/tip-tap/node/image-node/image-node.scss'
import '@repo/ui/components/tip-tap/node/list-node/list-node.scss'
import '@repo/ui/components/tip-tap/node/paragraph-node/paragraph-node.scss'

// --- Tiptap UI ---
import { BlockquoteButton } from '@repo/ui/components/tip-tap/ui/blockquote-button'
import { ChartButton } from '@repo/ui/components/tip-tap/ui/chart-button'
import { CodeBlockButton } from '@repo/ui/components/tip-tap/ui/code-block-button'
import {
  ColorHighlightPopover,
  ColorHighlightPopoverButton,
  ColorHighlightPopoverContent,
} from '@repo/ui/components/tip-tap/ui/color-highlight-popover'
import { HeadingDropdownMenu } from '@repo/ui/components/tip-tap/ui/heading-dropdown-menu'
import {
  LinkButton,
  LinkContent,
  LinkPopover,
} from '@repo/ui/components/tip-tap/ui/link-popover'
import { ListDropdownMenu } from '@repo/ui/components/tip-tap/ui/list-dropdown-menu'
import { MarkButton } from '@repo/ui/components/tip-tap/ui/mark-button'
import { TextAlignButton } from '@repo/ui/components/tip-tap/ui/text-align-button'
import { UndoRedoButton } from '@repo/ui/components/tip-tap/ui/undo-redo-button'

// --- Icons ---
import { ArrowLeftIcon } from '@repo/ui/components/tip-tap/icons/arrow-left-icon'
import { HighlighterIcon } from '@repo/ui/components/tip-tap/icons/highlighter-icon'
import { LinkIcon } from '@repo/ui/components/tip-tap/icons/link-icon'

// --- Hooks ---
import { useCursorVisibility } from '@repo/ui/hooks/use-cursor-visibility'
import { useIsMobile } from '@repo/ui/hooks/use-mobile'
import { useWindowSize } from '@repo/ui/hooks/use-window-size'

// --- Lib ---

// --- Styles ---
import '@repo/ui/components/tip-tap/templates/simple/simple-editor.scss'

const MainToolbarContent = ({
  onHighlighterClick,
  onLinkClick,
  isMobile,
  showChartButton,
}: {
  onHighlighterClick: () => void
  onLinkClick: () => void
  isMobile: boolean
  showChartButton: boolean
}) => {
  return (
    <>
      <Spacer />

      <ToolbarGroup>
        <UndoRedoButton action="undo" />
        <UndoRedoButton action="redo" />
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <HeadingDropdownMenu levels={[1, 2, 3, 4]} portal={isMobile} />
        <ListDropdownMenu
          types={['bulletList', 'orderedList', 'taskList']}
          portal={isMobile}
        />
        <BlockquoteButton />
        <CodeBlockButton />
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <MarkButton type="bold" />
        <MarkButton type="italic" />
        <MarkButton type="strike" />
        <MarkButton type="code" />
        <MarkButton type="underline" />
        {!isMobile ? (
          <ColorHighlightPopover />
        ) : (
          <ColorHighlightPopoverButton onClick={onHighlighterClick} />
        )}
        {!isMobile ? <LinkPopover /> : <LinkButton onClick={onLinkClick} />}
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <MarkButton type="superscript" />
        <MarkButton type="subscript" />
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <TextAlignButton align="left" />
        <TextAlignButton align="center" />
        <TextAlignButton align="right" />
        <TextAlignButton align="justify" />
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        {/* <ImageUploadButton text="Add" /> */}
        {showChartButton && <ChartButton text="Chart" />}
      </ToolbarGroup>

      <Spacer />

      {isMobile && <ToolbarSeparator />}
    </>
  )
}

const MobileToolbarContent = ({
  type,
  onBack,
}: {
  type: 'highlighter' | 'link'
  onBack: () => void
}) => (
  <>
    <ToolbarGroup>
      <Button data-style="ghost" onClick={onBack}>
        <ArrowLeftIcon className="tiptap-button-icon" />
        {type === 'highlighter' ? (
          <HighlighterIcon className="tiptap-button-icon" />
        ) : (
          <LinkIcon className="tiptap-button-icon" />
        )}
      </Button>
    </ToolbarGroup>

    <ToolbarSeparator />

    {type === 'highlighter' ? (
      <ColorHighlightPopoverContent />
    ) : (
      <LinkContent />
    )}
  </>
)

type SimpleEditorProps = {
  onUpdate: (json: any) => void
  content: Content
  chartFormBuilder?: ChartFormBuilder
}

export function SimpleEditor({
  onUpdate,
  content,
  chartFormBuilder,
}: SimpleEditorProps) {
  const isMobile = useIsMobile()
  const { height } = useWindowSize()
  const [mobileView, setMobileView] = React.useState<
    'main' | 'highlighter' | 'link'
  >('main')
  const toolbarRef = React.useRef<HTMLDivElement>(null)

  const extensions = React.useMemo(() => {
    return [
      ...getReportTiptapExtensions({
        chartNodeExtension: ChartNode.configure({
          formBuilder: chartFormBuilder,
        }),
        horizontalRuleExtension: HorizontalRule,
      }),
      Selection,
      // ImageUploadNode.configure({
      //   accept: 'image/*',
      //   maxSize: MAX_FILE_SIZE,
      //   limit: 3,
      //   upload: handleImageUpload,
      //   onError: (error) => console.error('Upload failed:', error),
      // }),
    ] satisfies Extensions
  }, [chartFormBuilder])

  const editor = useEditor({
    onUpdate: (props) => {
      onUpdate(props.editor.state.doc.toJSON())
    },

    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        autocomplete: 'off',
        autocorrect: 'off',
        autocapitalize: 'off',
        'aria-label': 'Main content area, start typing to enter text.',
        class: 'simple-editor',
      },
      handleDrop: (view) => {
        // HACK: to fix disappearing caret after drag-drop
        // After a drag-drop, the browser keeps focus on the contenteditable
        // but stops rendering the caret. Blur + refocus forces the browser
        // to recalculate and redraw the caret.
        setTimeout(() => {
          view.dom.blur()
          view.dom.focus()
        }, 50)
        return false
      },
    },
    extensions,
    content,
  })

  const rect = useCursorVisibility({
    editor,
    overlayHeight: toolbarRef.current?.getBoundingClientRect().height ?? 0,
  })

  React.useEffect(() => {
    if (!isMobile && mobileView !== 'main') {
      setMobileView('main')
    }
  }, [isMobile, mobileView])

  return (
    <div className="simple-editor-wrapper">
      <EditorContext.Provider value={{ editor }}>
        <Toolbar
          ref={toolbarRef}
          style={{
            ...(isMobile
              ? {
                  bottom: `calc(100% - ${height - rect.y}px)`,
                }
              : {}),
          }}
        >
          {mobileView === 'main' ? (
            <MainToolbarContent
              onHighlighterClick={() => setMobileView('highlighter')}
              onLinkClick={() => setMobileView('link')}
              isMobile={isMobile}
              showChartButton={Boolean(chartFormBuilder)}
            />
          ) : (
            <MobileToolbarContent
              type={mobileView === 'highlighter' ? 'highlighter' : 'link'}
              onBack={() => setMobileView('main')}
            />
          )}
        </Toolbar>

        {editor && (
          <DragHandle editor={editor}>
            <div className="tiptap-drag-handle">
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <circle cx="5" cy="3" r="1.5" />
                <circle cx="11" cy="3" r="1.5" />
                <circle cx="5" cy="8" r="1.5" />
                <circle cx="11" cy="8" r="1.5" />
                <circle cx="5" cy="13" r="1.5" />
                <circle cx="11" cy="13" r="1.5" />
              </svg>
            </div>
          </DragHandle>
        )}

        <EditorContent
          editor={editor}
          role="presentation"
          className="simple-editor-content"
        />
      </EditorContext.Provider>
    </div>
  )
}

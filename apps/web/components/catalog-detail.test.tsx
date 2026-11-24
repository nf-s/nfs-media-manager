import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { CatalogNativeKindSchema } from '@repo/schemas/catalog'
import { CatalogLibraryAction } from './catalog-detail'

test('catalog detail actions appear only for items outside the library', () => {
  const client = new QueryClient()
  try {
    for (const kind of CatalogNativeKindSchema.options) {
      function render(inLibrary: boolean) {
        return renderToStaticMarkup(
          <QueryClientProvider client={client}>
            <CatalogLibraryAction
              id="fixture"
              kind={kind}
              title="Example"
              inLibrary={inLibrary}
            />
          </QueryClientProvider>,
        )
      }
      assert.equal(render(true), '', kind)
      assert.match(
        render(false),
        /aria-label="Add [^"]+ to library · Example"/,
        kind,
      )
    }
  } finally {
    client.clear()
  }
})

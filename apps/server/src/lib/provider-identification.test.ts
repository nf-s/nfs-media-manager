import { describe, expect, it } from 'vitest'
import {
  canIdentifyMedia,
  hasProviderIdentifier,
} from './provider-identification'

describe('provider-specific album identification', () => {
  it('accepts shared validated RYM URLs for Serply, including corrected review URLs', () => {
    const provider = { id: 'serply', identifierTypes: ['rym-url'] }
    expect(
      hasProviderIdentifier(provider, 'album', [
        {
          provider: 'google-custom-search',
          referenceType: 'rym-url',
          externalId:
            'https://rateyourmusic.com/release/album/charli-xcx/brat/',
        },
      ]),
    ).toBe(true)
    expect(
      hasProviderIdentifier(provider, 'album', [
        {
          provider: 'retired-provider',
          referenceType: 'rym-url',
          externalId:
            'https://rateyourmusic.com/music-review/cyarbrough/marina-herlop/dja-dja/302502412',
        },
      ]),
    ).toBe(true)
    expect(
      hasProviderIdentifier(provider, 'album', [
        {
          provider: 'retired-provider',
          referenceType: 'rym-url',
          externalId: 'https://attacker.test/release/album/a/b/',
        },
      ]),
    ).toBe(false)
  })
  const provider = { id: 'spotify', identifierTypes: ['album'] }
  it('does not use another provider album ID as a Spotify ID', () => {
    expect(
      hasProviderIdentifier(provider, 'album', [
        { provider: 'lastfm', referenceType: 'album', externalId: 'some-id' },
      ]),
    ).toBe(false)
    expect(
      hasProviderIdentifier(provider, 'album', [
        {
          provider: 'spotify',
          referenceType: 'album',
          externalId: 'spotify-id',
        },
      ]),
    ).toBe(true)
  })
  it('permits artist/title matching only when the provider supports it', () => {
    const item = {
      mediaType: 'album',
      title: 'Test album',
      artists: ['Test artist'],
      providerReferences: [],
    } satisfies Parameters<typeof canIdentifyMedia>[1]
    expect(canIdentifyMedia(provider, item)).toBe(false)
    expect(
      canIdentifyMedia({ ...provider, supportsNameLookup: true }, item),
    ).toBe(true)
    expect(
      canIdentifyMedia(
        { ...provider, supportsNameLookup: true },
        { ...item, artists: [] },
      ),
    ).toBe(false)
    expect(
      canIdentifyMedia(
        { ...provider, supportsNameLookup: true },
        { ...item, title: ' ' },
      ),
    ).toBe(false)
  })
  it('allows validated shared barcodes but never treats arbitrary provider IDs as shared', () => {
    const barcodeProvider = { id: 'musicbrainz', identifierTypes: ['upc'] }
    expect(
      hasProviderIdentifier(barcodeProvider, 'album', [
        {
          provider: 'spotify',
          referenceType: 'upc',
          externalId: '0123456789012',
        },
      ]),
    ).toBe(true)
    expect(
      hasProviderIdentifier(barcodeProvider, 'album', [
        {
          provider: 'spotify',
          referenceType: 'upc',
          externalId: 'not-a-barcode',
        },
      ]),
    ).toBe(false)
  })
  it('accepts explicitly namespaced Spotify IDs from CSV imports', () => {
    const spotify = { id: 'spotify', identifierTypes: ['album', 'spotify'] }
    expect(
      hasProviderIdentifier(spotify, 'album', [
        {
          provider: 'album-csv',
          referenceType: 'spotify',
          externalId: '52kBHAvk3mxswlCWcHrSC4',
        },
      ]),
    ).toBe(true)
    expect(
      hasProviderIdentifier(spotify, 'album', [
        {
          provider: 'album-csv',
          referenceType: 'spotify',
          externalId: 'bad-id',
        },
      ]),
    ).toBe(false)
  })
  it('retains shared film identity and validates supported identifiers', () => {
    const filmProvider = { id: 'omdb', identifierTypes: ['imdb'] }
    expect(
      hasProviderIdentifier(filmProvider, 'film', [
        { provider: 'tmdb', referenceType: 'imdb', externalId: 'tt1234' },
      ]),
    ).toBe(true)
    expect(
      hasProviderIdentifier(filmProvider, 'film', [
        { provider: 'tmdb', referenceType: 'imdb', externalId: 'invalid' },
      ]),
    ).toBe(false)
  })
})

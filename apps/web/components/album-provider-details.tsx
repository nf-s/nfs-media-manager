import React from 'react'
import type { AlbumProviderDetails as ProviderDetails } from '@repo/schemas/album-provider-details'
import ExternalLink from './external-link'

const names = {
  musicbrainz: 'MusicBrainz',
  discogs: 'Discogs',
  lastfm: 'Last.fm',
}

export default function AlbumProviderDetails({
  details,
}: {
  details: ProviderDetails[]
}) {
  if (!details.length) return null
  return (
    <details className="mt-5 text-sm">
      <summary>More album info</summary>
      <div className="mt-3 space-y-5">
        {details.map((source) => (
          <section key={source.provider}>
            <h2 className="mb-2 font-semibold">
              {source.url ? (
                <ExternalLink href={source.url}>
                  {names[source.provider]}
                </ExternalLink>
              ) : (
                names[source.provider]
              )}
            </h2>
            {source.facts.length > 0 && (
              <dl className="detail-metrics">
                {source.facts.map((fact, index) => (
                  <div key={`${fact.label}-${index}`}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {source.notes.map((note, index) => (
              <details key={`${note.label}-${index}`} className="my-2">
                <summary>{note.label}</summary>
                <p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                  {note.text}
                </p>
              </details>
            ))}
            {source.credits.length > 0 && (
              <details className="my-2">
                <summary>Credits ({source.credits.length})</summary>
                <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1">
                  {source.credits.map((credit, index) => (
                    <React.Fragment
                      key={`${credit.name}-${credit.role}-${index}`}
                    >
                      <dt className="quiet break-words">{credit.role}</dt>
                      <dd className="break-words">{credit.name}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </details>
            )}
            {source.tags.length > 0 && (
              <details className="my-2">
                <summary>Original tags ({source.tags.length})</summary>
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {source.tags.map((tag, index) => (
                    <li key={`${tag.kind}-${tag.name}-${index}`}>
                      {tag.name}
                      {tag.count !== undefined && (
                        <span className="quiet">
                          {' '}
                          · {tag.count}
                          {tag.countLabel ? ` ${tag.countLabel}` : ''}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {source.tracks.length > 0 && (
              <details className="my-2">
                <summary>Source tracklist ({source.tracks.length})</summary>
                <ol className="mt-2 space-y-1">
                  {source.tracks.map((track, index) => (
                    <li key={`${track.position}-${index}`}>
                      <span className="quiet mr-2">
                        {track.position ?? index + 1}
                      </span>
                      {track.url ? (
                        <ExternalLink href={track.url}>
                          {track.title}
                        </ExternalLink>
                      ) : (
                        track.title
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {source.links.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                {source.links.map((link, index) => (
                  <ExternalLink key={`${link.url}-${index}`} href={link.url}>
                    {link.label}
                  </ExternalLink>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </details>
  )
}

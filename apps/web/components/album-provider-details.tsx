import React from 'react'
import type { AlbumProviderDetails as ProviderDetails } from '@repo/schemas/album-provider-details'
import { formatCount } from '@repo/ui/lib/format'

const names = {
  musicbrainz: 'MusicBrainz',
  discogs: 'Discogs',
  lastfm: 'Last.fm',
}

function ProviderLink({ url, children }: { url: string; children: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${children} (opens in a new tab)`}
    >
      {children}
    </a>
  )
}

/** Album information a provider returned that has no field of its own. */
export default function AlbumProviderDetails({
  details,
}: {
  details: ProviderDetails[]
}) {
  if (!details.length) return null
  return (
    <details className="data-disclosure">
      <summary>More album info</summary>
      <div className="data-stack">
        {details.map((source) => (
          <section
            key={source.provider}
            className="data-stack"
            aria-label={names[source.provider]}
          >
            {source.url && (
              <span>
                <ProviderLink url={source.url}>
                  {`Open on ${names[source.provider]}`}
                </ProviderLink>
              </span>
            )}
            {source.facts.length > 0 && (
              <dl className="ds-kv">
                {source.facts.map((fact, index) => (
                  <React.Fragment key={`${fact.label}-${index}`}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            )}
            {source.notes.map((note, index) => (
              <details
                key={`${note.label}-${index}`}
                className="data-disclosure"
              >
                <summary>{note.label}</summary>
                <p className="data-prose">{note.text}</p>
              </details>
            ))}
            {source.credits.length > 0 && (
              <details className="data-disclosure">
                <summary>Credits ({source.credits.length})</summary>
                <dl className="ds-kv">
                  {source.credits.map((credit, index) => (
                    <React.Fragment
                      key={`${credit.name}-${credit.role}-${index}`}
                    >
                      <dt>{credit.role}</dt>
                      <dd>{credit.name}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </details>
            )}
            {source.tags.length > 0 && (
              <details className="data-disclosure">
                <summary>Original tags ({source.tags.length})</summary>
                <ul className="data-picker">
                  {source.tags.map((tag, index) => (
                    <li key={`${tag.kind}-${tag.name}-${index}`}>
                      {tag.name}
                      {tag.count !== undefined && (
                        <span className="ds-muted">
                          {formatCount(tag.count)}
                          {tag.countLabel ? ` ${tag.countLabel}` : ''}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {source.tracks.length > 0 && (
              <details className="data-disclosure">
                <summary>Source tracklist ({source.tracks.length})</summary>
                <ol className="data-picker">
                  {source.tracks.map((track, index) => (
                    <li key={`${track.position}-${index}`}>
                      <span className="ds-muted ds-num">
                        {track.position ?? index + 1}
                      </span>
                      {track.url ? (
                        <ProviderLink url={track.url}>
                          {track.title}
                        </ProviderLink>
                      ) : (
                        track.title
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {source.links.length > 0 && (
              <ul className="data-picker">
                {source.links.map((link, index) => (
                  <li key={`${link.url}-${index}`}>
                    <ProviderLink url={link.url}>{link.label}</ProviderLink>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </details>
  )
}

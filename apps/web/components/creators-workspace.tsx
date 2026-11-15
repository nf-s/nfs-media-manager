'use client'

import {
  ArtistPageSchema,
  PersonPageSchema,
  type ArtistSummary,
  type PersonSummary,
} from '@repo/schemas/creators'
import {
  CreatorLibraryDate,
  CreatorLibraryTable,
  CreatorLibraryTitle,
  type CreatorLibraryColumn,
} from './creator-library-table'
import MediaArtwork from './media-artwork'
import { usePersonRoleFilter } from './person-role-filter'

const artistColumns: CreatorLibraryColumn<ArtistSummary>[] = [
  {
    key: 'artwork',
    label: 'Artwork',
    sortable: false,
    className: 'w-10',
    render: (artist) => (
      <MediaArtwork
        src={artist.artworkUrl}
        alt=""
        fallbackLabel=""
        containerClassName="size-6 rounded"
        imageClassName="size-6 object-cover"
        fallbackClassName="size-6"
      />
    ),
  },
  {
    key: 'name',
    label: 'Artist',
    required: true,
    render: (artist) => (
      <CreatorLibraryTitle kind="artist" id={artist.id} title={artist.name} />
    ),
  },
  {
    key: 'albumCount',
    label: 'Albums',
    className: 'numeric',
    render: (artist) => artist.albumCount.toLocaleString(),
  },
  {
    key: 'trackCount',
    label: 'Tracks',
    className: 'numeric',
    render: (artist) => artist.trackCount.toLocaleString(),
  },
  {
    key: 'playlistCount',
    label: 'Playlists',
    className: 'numeric',
    render: (artist) => artist.playlistCount.toLocaleString(),
  },
  {
    key: 'createdAt',
    label: 'Added',
    defaultVisible: false,
    render: (artist) => <CreatorLibraryDate value={artist.createdAt} />,
  },
]

export function ArtistsWorkspace() {
  return (
    <section className="admin-page table-workspace">
      <h1>Artists</h1>
      <CreatorLibraryTable
        workspace
        kind="artist"
        queryKey={['artists']}
        path="/api/v1/artists"
        schema={ArtistPageSchema}
        columns={artistColumns}
        label="artists"
        defaultSort={{ key: 'name', direction: 'asc' }}
      />
    </section>
  )
}

export function PeopleWorkspace() {
  const roles = usePersonRoleFilter()
  const columns: CreatorLibraryColumn<PersonSummary>[] = [
    {
      key: 'name',
      label: 'Person',
      required: true,
      filter: roles.control,
      render: (person) => (
        <CreatorLibraryTitle kind="person" id={person.id} title={person.name} />
      ),
    },
    {
      key: 'filmCount',
      label: 'Films',
      className: 'numeric',
      render: (person) => person.filmCount.toLocaleString(),
    },
    {
      key: 'directorCount',
      label: 'As director',
      className: 'numeric',
      render: (person) => person.directorCount.toLocaleString(),
    },
    {
      key: 'actorCount',
      label: 'As actor',
      className: 'numeric',
      render: (person) => person.actorCount.toLocaleString(),
    },
    {
      key: 'createdAt',
      label: 'Added',
      defaultVisible: false,
      render: (person) => <CreatorLibraryDate value={person.createdAt} />,
    },
  ]
  return (
    <section className="admin-page table-workspace">
      <h1>People</h1>
      <CreatorLibraryTable
        workspace
        kind="person"
        queryKey={['people']}
        path="/api/v1/people"
        schema={PersonPageSchema}
        columns={columns}
        label="people"
        defaultSort={{ key: 'name', direction: 'asc' }}
        filters={roles.filters}
      />
    </section>
  )
}

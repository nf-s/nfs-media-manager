import { describe, expect, it } from 'vitest'
import { mergeTagEdges } from './tag-hierarchy'

function sorted(edges: { child: string; parent: string }[]) {
  return edges
    .map((edge) => `${edge.child}>${edge.parent}`)
    .sort((a, b) => a.localeCompare(b))
}

describe('mergeTagEdges', () => {
  it('gives the surviving tag the merged tag parents and subtags', () => {
    const edges = [
      { child: 'synth-pop', parent: 'pop' },
      { child: 'electropop', parent: 'synth-pop' },
      { child: 'synthpop', parent: 'electronic' },
      { child: 'shoegaze', parent: 'rock' },
    ]
    expect(sorted(mergeTagEdges(edges, ['synth-pop'], 'synthpop'))).toEqual([
      'electropop>synthpop',
      'shoegaze>rock',
      'synthpop>electronic',
      'synthpop>pop',
    ])
  })

  it('drops the link between a parent and the subtag it merges into', () => {
    const edges = [
      { child: 'dance', parent: 'electronic dance music' },
      { child: 'electronic dance music', parent: 'electronic' },
    ]
    expect(
      sorted(mergeTagEdges(edges, ['electronic dance music'], 'dance')),
    ).toEqual(['dance>electronic'])
  })

  it('keeps existing links when an inherited link would form a loop', () => {
    const edges = [
      { child: 'house', parent: 'dance' },
      { child: 'deep house', parent: 'house' },
      { child: 'club', parent: 'deep house' },
    ]
    // club would become a parent of house while already sitting beneath it.
    expect(sorted(mergeTagEdges(edges, ['dance'], 'club'))).toEqual([
      'club>deep house',
      'deep house>house',
    ])
  })

  it('does not repeat a link both tags already share', () => {
    const edges = [
      { child: 'idm', parent: 'electronic' },
      { child: 'intelligent dance music', parent: 'electronic' },
    ]
    expect(
      sorted(mergeTagEdges(edges, ['idm'], 'intelligent dance music')),
    ).toEqual(['intelligent dance music>electronic'])
  })
})

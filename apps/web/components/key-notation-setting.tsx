'use client'

import { Section } from '@repo/ui/components/ds/facts'
import { Segmented } from '@repo/ui/components/ds/segmented'
import {
  formatMusicalKey,
  KeyNotationSchema,
  keyNotationLabels,
} from '@repo/schemas/musical-keys'
import { setKeyNotation, useKeyNotation } from '@/utils/key-notation'

const options = KeyNotationSchema.options.map((notation) => ({
  value: notation,
  label: `${keyNotationLabels[notation]} (${formatMusicalKey('8A', notation)})`,
}))

/** How track keys are written in Tracks Browse and track details. */
export function KeyNotationSetting() {
  const notation = useKeyNotation()
  return (
    <Section title="Key notation" note="Saved in this browser">
      <Segmented
        label="Key notation"
        value={notation}
        options={options}
        onChange={setKeyNotation}
      />
    </Section>
  )
}

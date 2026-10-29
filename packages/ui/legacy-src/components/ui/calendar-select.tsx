'use client'

import { PopoverAnchor } from '@radix-ui/react-popover'
import { Calendar } from '@repo/ui/components/ui/calendar'
import { Popover, PopoverContent } from '@repo/ui/components/ui/popover'
import { formatDateTime } from '@repo/ui/lib/date'
import { CalendarIcon } from 'lucide-react'
import { ChangeEvent, useState } from 'react'
import { InputGroup, InputGroupButton, InputGroupInput } from './input-group'

export function CalendarSelect({
  value,
  onChange,
}: {
  label: string
  value: Date | undefined
  onChange: (date: Date | undefined) => void
}) {
  const [open, setOpen] = useState(false)

  // Hold the month in state to control the calendar when the input changes
  const [month, setMonth] = useState(new Date())

  // Hold the input value in state
  const [inputValue, setInputValue] = useState('')

  const handleDayPickerSelect = (date: Date | undefined) => {
    if (!date) {
      setInputValue('')
      onChange(undefined)
    } else {
      onChange(date)
      setMonth(date)
      setInputValue(formatDateTime(date))
    }
    setOpen(false)
  }

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value) // Keep the input value in sync

    try {
      let parsedDate: Date
      // If the input value is a 4 digit year
      if (e.target.value.length === 4) {
        const year = parseInt(e.target.value)
        parsedDate = new Date(year, 0, 1, 0, 0, 0, 0)
      } else {
        // Parse the date string and create a UTC date
        parsedDate = new Date(Date.parse(e.target.value))
      }

      // Extract components and create a UTC date (midnight UTC)
      const year = parsedDate.getFullYear()
      const month = parsedDate.getMonth()
      const day = parsedDate.getDate()
      const hours = parsedDate.getHours()
      const minutes = parsedDate.getMinutes()
      const seconds = parsedDate.getSeconds()
      const utcDate = new Date(
        Date.UTC(year, month, day, hours, minutes, seconds),
      )

      onChange(utcDate)
      setMonth(utcDate)
    } catch (error) {
      onChange(undefined)
    }
  }

  return (
    <div className="w-full flex flex-col gap-3 relative">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <InputGroup>
            <InputGroupInput
              value={inputValue}
              placeholder="dd/mm/yyyy (UTC)"
              onChange={handleInputChange}
            />

            <InputGroupButton
              id="date"
              className="h-full"
              onClick={() => setOpen(true)}
              animate={false}
            >
              <CalendarIcon />
            </InputGroupButton>
          </InputGroup>
        </PopoverAnchor>
        <PopoverContent
          className="max-w-[--radix-popper-anchor-width] overflow-hidden p-0"
          align="end"
        >
          <Calendar
            month={month}
            onMonthChange={setMonth}
            mode="single"
            captionLayout="dropdown"
            selected={value}
            onSelect={handleDayPickerSelect}
            footer={value ? `Selected: ${formatDateTime(value)}` : undefined}
            className="w-full"
            timeZone="UTC"
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

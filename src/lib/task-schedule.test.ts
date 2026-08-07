import { describe, expect, it } from "vitest"
import {
  formatScheduleShort,
  isoToDateTimeLocalValue,
  isScheduleInPast,
  parseDateTimeLocalValue,
  schedulePresets,
  toDateTimeLocalValue,
} from "./task-schedule"

describe("task-schedule", () => {
  it("round-trips a picked time through local wall-clock, not UTC", () => {
    const picked = new Date(2026, 7, 8, 9, 30)
    const value = toDateTimeLocalValue(picked)
    expect(value).toBe("2026-08-08T09:30")
    // What the dialog sends and what it reads back must agree to the minute,
    // in every zone the test machine might run in.
    const iso = parseDateTimeLocalValue(value)!.toISOString()
    expect(isoToDateTimeLocalValue(iso)).toBe(value)
  })

  it("pads single-digit parts so the input accepts the value", () => {
    expect(toDateTimeLocalValue(new Date(2026, 0, 2, 3, 4))).toBe(
      "2026-01-02T03:04"
    )
  })

  it("rejects an empty or half-typed value", () => {
    expect(parseDateTimeLocalValue("")).toBeNull()
    expect(parseDateTimeLocalValue("2026-08-08")).toBeNull()
    expect(parseDateTimeLocalValue("2026-08-08T09")).toBeNull()
    expect(parseDateTimeLocalValue("not a time")).toBeNull()
  })

  it("flags a time that has already passed", () => {
    const now = new Date(2026, 7, 8, 9, 30).getTime()
    expect(isScheduleInPast(new Date(now - 1000), now)).toBe(true)
    // Exactly now counts as past: the engine would start it immediately.
    expect(isScheduleInPast(new Date(now), now)).toBe(true)
    expect(isScheduleInPast(new Date(now + 60_000), now)).toBe(false)
  })

  it("offers +1h, +3h and tomorrow morning", () => {
    const now = new Date(2026, 7, 8, 22, 47, 31)
    const [hour, threeHours, tomorrow] = schedulePresets(now)
    // Seconds are dropped so the preview reads as a clean minute.
    expect(hour.value).toBe("2026-08-08T23:47")
    // Rolls into the next day rather than clamping at midnight.
    expect(threeHours.value).toBe("2026-08-09T01:47")
    expect(tomorrow.value).toBe("2026-08-09T09:00")
  })

  it("returns an empty label for an unparsable instant", () => {
    expect(formatScheduleShort("nonsense")).toBe("")
  })
})

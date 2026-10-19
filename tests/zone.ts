const RealDate = Date

/** Sets the local time zone every Date in this test file's realm reads, as minutes east of UTC. The mod a test mounts keeps the machine's zone. */
export function setZone(minutesEast: number): void {
  class ZonedDate extends RealDate {
    override getTimezoneOffset(): number {
      return -minutesEast
    }
  }
  globalThis.Date = ZonedDate as DateConstructor
}

/** `HH:MM:SS` of `ts` in the machine's local time zone, the zone a mounted mod formats in. */
export function machineTime(ts: number): string {
  return new RealDate(ts - new RealDate(ts).getTimezoneOffset() * 60_000).toISOString().slice(11, 19)
}

// BRF-1: due-ness is computed in the project's IANA timezone via Intl — never
// server-local offsets. Briefs fire at/after 07:00 local, at most once per local
// day (daily) or local Monday (weekly).

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(now: Date, tz: string): { y: number; m: number; d: number; hour: number; dow: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    hour: Number(parts.hour) % 24, // Intl renders midnight as "24" in some locales
    dow: DOW[parts.weekday!] ?? 0,
  };
}

const sameLocalDay = (a: ReturnType<typeof localParts>, b: ReturnType<typeof localParts>) =>
  a.y === b.y && a.m === b.m && a.d === b.d;

export function briefDue(
  schedule: "daily" | "weekly" | null,
  tz: string,
  lastWindowEnd: Date | null,
  now: Date,
): boolean {
  if (schedule === null) return false;
  const local = localParts(now, tz);
  if (local.hour < 7) return false;
  if (schedule === "weekly" && local.dow !== 1) return false;
  if (lastWindowEnd === null) return true;
  return !sameLocalDay(localParts(lastWindowEnd, tz), local);
}

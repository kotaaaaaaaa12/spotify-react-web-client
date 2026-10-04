export interface LyricLine { time: number; text: string }

export function parseSyncedLyrics(value: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const offset = Number(value.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0);
  for (const raw of value.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d{2}(?:\.\d+)?)\]/g)];
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const stamp of stamps) {
      const seconds = Number(stamp[2]);
      if (seconds < 60) lines.push({ time: Math.max(0, (Number(stamp[1]) * 60 + seconds) * 1000 + offset), text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

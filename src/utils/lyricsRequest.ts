export interface LyricsRecord {
  source: string;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

const recent = new Map<string, { record: LyricsRecord | null; expires: number }>();
const message = 'Could not connect to the lyrics service. Try again.';

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 800);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function fetchLyrics(signature: string, signal: AbortSignal): Promise<LyricsRecord | null> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const cached = recent.get(signature);
  if (cached && cached.expires > Date.now()) return cached.record;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 35000);
    let retryable = true;
    try {
      const response = await fetch(`/api/lyrics?${signature}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.headers.get('Content-Type')?.includes('json')) throw new Error(message);
      const data = await response.json();
      if (!response.ok && response.status !== 404) {
        retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new Error(message);
      }
      let record: LyricsRecord | null = null;
      if (response.ok) {
        if (!data || data.source !== 'LRCLIB' || typeof data.instrumental !== 'boolean'
          || !(data.plainLyrics === null || typeof data.plainLyrics === 'string')
          || !(data.syncedLyrics === null || typeof data.syncedLyrics === 'string')) throw new Error(message);
        record = data;
      } else if (data?.code !== 'not_found' && data?.error !== 'No lyrics were found for this recording.') {
        throw new Error(message);
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      recent.delete(signature);
      recent.set(signature, { record, expires: Date.now() + (record ? 3600000 : 300000) });
      if (recent.size > 50) recent.delete(recent.keys().next().value!);
      return record;
    } catch {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!retryable || attempt === 1) throw new Error(message);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
    await pause(signal);
  }
  throw new Error(message);
}

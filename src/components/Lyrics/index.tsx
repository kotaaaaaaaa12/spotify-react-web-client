import { useEffect, useMemo, useRef, useState } from 'react';
import { FiChevronDown, FiMic } from 'react-icons/fi';
import { useAppDispatch, useAppSelector } from '../../store/store';
import { uiActions } from '../../store/slices/ui';
import { parseSyncedLyrics } from '../../utils/lyrics';
import { playerService } from '../../services/player';

interface LyricsRecord { source: string; instrumental: boolean; plainLyrics: string | null; syncedLyrics: string | null }

export default function Lyrics() {
  const dispatch = useAppDispatch();
  const open = useAppSelector(state => !!state.ui.lyricsExpanded);
  const song = useAppSelector(state => state.spotify.state?.track_window.current_track);
  const duration = useAppSelector(state => state.spotify.state?.duration || 0);
  const position = useAppSelector(state => state.spotify.state?.position || 0);
  const canSeek = useAppSelector(state => !state.spotify.state?.disallows?.seeking);
  const [record, setRecord] = useState<LyricsRecord>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const activeLine = useRef<HTMLButtonElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const signature = useMemo(() => new URLSearchParams({ track_name: song?.name || '', artist_name: song?.artists[0]?.name || '',
    album_name: song?.album.name || '', duration: String(duration / 1000) }).toString(), [song?.name, song?.artists[0]?.name, song?.album.name, duration]);
  const [loadedSignature, setLoadedSignature] = useState('');
  useEffect(() => {
    if (!open || !song) return;
    const controller = new AbortController();
    setLoading(true); setError(undefined); setRecord(undefined); setLoadedSignature(signature);
    void fetch(`/api/lyrics?${signature}`, { signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load lyrics.');
      if (!controller.signal.aborted) setRecord(data);
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to load lyrics.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, signature, retry, song?.id]);
  const current = loadedSignature === signature ? record : undefined;
  const lines = useMemo(() => parseSyncedLyrics(current?.syncedLyrics || ''), [current?.syncedLyrics]);
  const active = lines.reduce((index, line, i) => line.time <= position ? i : index, -1);
  useEffect(() => {
    const target = activeLine.current, container = viewport.current;
    if (!target || !container) return;
    const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: Math.max(0, top - container.clientHeight / 2 + target.clientHeight / 2), behavior: 'smooth' });
  }, [active]);
  return <section className="lyrics-card" aria-label="Lyrics">
    <button className="lyrics-toggle" aria-expanded={open} onClick={() => dispatch(uiActions.setLyricsExpanded(!open))}>
      <span><FiMic aria-hidden="true" /> Lyrics</span><FiChevronDown className={open ? 'expanded' : ''} aria-hidden="true" />
    </button>
    {open ? <div className="lyrics-body">
      {loading || loadedSignature !== signature ? <p role="status">Loading lyrics…</p> : error ? <div><p role="status">{error}</p><button className="lyrics-retry" onClick={() => setRetry(value => value + 1)}>Retry</button></div> : current?.instrumental ? <p>This is an instrumental track.</p> : lines.length ?
        <div className="lyrics-lines" ref={viewport}>{lines.map((line, i) => <button key={i} ref={i === active ? activeLine : undefined}
          className={`lyric-line ${i === active ? 'active' : ''}`} disabled={!canSeek} aria-current={i === active ? 'true' : undefined}
          onClick={() => void playerService.seekToPosition(line.time).catch(() => {})}>{line.text || '♪'}</button>)}</div> : current?.plainLyrics ?
        <div className="lyrics-lines lyrics-plain">{current.plainLyrics}</div> : <p>No lyrics were found for this recording.</p>}
      <a className="lyrics-source" href="https://lrclib.net" target="_blank" rel="noreferrer">Lyrics provided by LRCLIB</a>
    </div> : null}
  </section>;
}

import SongDetails from './SongDetails';
import { useAppDispatch, useAppSelector } from '../../../../store/store';
import { Col, Row } from 'antd';
import { ListIcon, Pause, Play } from '../../../Icons';

// Redux
import { playerService } from '../../../../services/player';
import { useEffect, useRef, useState } from 'react';
import { getImageAnalysis2 } from '../../../../utils/imageAnyliser';
import { uiActions } from '../../../../store/slices/ui';
import tinycolor from 'tinycolor2';
import { AddSongToLibraryButton } from '../../../Actions/AddSongToLibrary';
import { spotifyActions } from '../../../../store/slices/spotify';

const PlayButton = () => {
  const paused = useAppSelector((state) => state.spotify.state?.paused);
  return (
    <button
      aria-label={paused ? 'Resume playback' : 'Pause playback'}
      onClick={() => (!paused ? playerService.pausePlayback() : playerService.startPlayback().catch(() => {}))}
    >
      {paused ? <Play /> : <Pause />}
    </button>
  );
};

const QueueButton = () => {
  const dispatch = useAppDispatch();
  return (
    <button aria-label="Queue" onClick={() => dispatch(uiActions.toggleQueue())}>
      <ListIcon />
    </button>
  );
};

const NowPlayingBarMobile = () => {
  const dispatch = useAppDispatch();
  const position = useAppSelector((state) => state.spotify.state?.position || 0);
  const duration = useAppSelector((state) => state.spotify.state?.duration || 1);
  const currentSong = useAppSelector(
    (state) => state.spotify.state?.track_window.current_track,
    (a, b) => a?.id === b?.id
  );
  const liked = useAppSelector((state) => state.spotify.liked);
  const [currentColor, setColor] = useState('#282828');
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const seeking = useRef(false);
  const seekDisabled = useAppSelector(state => !!state.spotify.state?.disallows.seeking);
  const commitSeek = (value: string) => {
    seeking.current = false; setSeekPreview(null);
    if (!seekDisabled) void playerService.seekToPosition(Number(value)).catch(() => {});
  };

  useEffect(() => {
    let cancelled = false; setColor('#282828');
    const cover = currentSong?.album.images[0]?.url;
    if (cover) void getImageAnalysis2(cover).then(r => {
      let color = tinycolor(r);
      while (color.isLight()) color = color.darken(10);
      if (!cancelled) setColor(color.toHexString());
    }).catch(() => {});
    seeking.current = false; setSeekPreview(null);
    return () => { cancelled = true; };
  }, [currentSong]);

  if (!currentSong) return <div></div>;

  return (
    <div>
      <div
        className='mobile-player' role='region' aria-label='Now playing'
        style={{ background: `linear-gradient(${currentColor} -50%, rgb(18, 18, 18) 300%)` }}
      >
        <Row justify='space-between' wrap={false} align='middle'>
          <Col className='mini-player-details'>
            <SongDetails isMobile />
          </Col>
          <Col style={{ display: 'flex' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                minWidth: 50,
                marginRight: 5,
                gap: 15,
                justifyContent: 'space-between',
              }}
            >
              <QueueButton />
              <AddSongToLibraryButton
                size={17}
                isSaved={liked}
                id={currentSong?.id!}
                onToggle={() => {
                  dispatch(spotifyActions.setLiked({ liked: !liked }));
                }}
              />
              <PlayButton />
            </div>
          </Col>
        </Row>
        <input type='range' className='mini-player-seek' aria-label='Seek' min={0} max={duration} step={1000}
          disabled={seekDisabled} value={seekPreview ?? Math.min(position, duration)}
          style={{ background: `linear-gradient(to right, white ${(Math.min(seekPreview ?? position, duration) / duration) * 100}%, #ffffff40 0%)` }}
          onPointerDown={event => { seeking.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
          onChange={event => setSeekPreview(Number(event.currentTarget.value))}
          onPointerUp={event => commitSeek(event.currentTarget.value)}
          onPointerCancel={() => { seeking.current = false; setSeekPreview(null); }}
          onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitSeek(event.currentTarget.value); }}
          onBlur={event => { if (seeking.current) commitSeek(event.currentTarget.value); }} />
      </div>
    </div>
  );
};

export default NowPlayingBarMobile;

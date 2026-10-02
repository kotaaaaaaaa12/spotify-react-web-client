import { memo, useLayoutEffect, useState } from 'react';

// Components
import { ConfigProvider, Drawer, theme } from 'antd';

// Redux
import { useAppDispatch, useAppSelector } from '../../store/store';
import { uiActions } from '../../store/slices/ui';
import YourLibrary from '../Layout/components/Library/list';

function useWindowSize() {
  const [size, setSize] = useState([window.innerWidth, window.innerHeight]);
  useLayoutEffect(() => {
    function updateSize() {
      setSize([window.innerWidth, window.innerHeight]);
    }
    window.addEventListener('resize', updateSize);
    updateSize();
    return () => window.removeEventListener('resize', updateSize);
  }, []);
  return size;
}

export const LibraryDrawer = memo(() => {
  const [width] = useWindowSize();
  const dispatch = useAppDispatch();

  const open = useAppSelector((state) => !state.ui.libraryCollapsed);

  if (width > 900) return null;

  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <Drawer open={open} rootClassName="spotify-mobile-drawer" title="Your library" placement="left"
        width="100%" zIndex={10010} autoFocus={false} onClose={() => dispatch(uiActions.collapseLibrary())}>
        <YourLibrary />
      </Drawer>
    </ConfigProvider>
  );
});

LibraryDrawer.displayName = 'LibraryDrawer';

import useCompactLayout from '../../utils/useCompactLayout';
import { memo } from 'react';

// Components
import { ConfigProvider, Drawer, theme } from 'antd';

// Redux
import { useAppDispatch, useAppSelector } from '../../store/store';
import { uiActions } from '../../store/slices/ui';
import YourLibrary from '../Layout/components/Library/list';

export const LibraryDrawer = memo(() => {
  const compact = useCompactLayout();
  const dispatch = useAppDispatch();

  const open = useAppSelector((state) => !state.ui.libraryCollapsed);

  if (!compact) return null;

  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <Drawer open={open} rootClassName="spotify-mobile-drawer spotify-library-drawer" title="Your Library" placement="left"
        width="100%" zIndex={10010} autoFocus={false} onClose={() => dispatch(uiActions.collapseLibrary())}>
        <YourLibrary embedded />
      </Drawer>
    </ConfigProvider>
  );
});

LibraryDrawer.displayName = 'LibraryDrawer';

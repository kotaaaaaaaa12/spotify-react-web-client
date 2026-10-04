// Components
import { Spin } from 'antd';
import { LibraryTitle } from '../Title';
import { ListItemComponent } from './ListCards';
import { CompactItemComponent } from './CompactCards';
import { LibraryFilters, SearchArea } from '../Filters';

// Redux
import { useAppDispatch, useAppSelector } from '../../../../../store/store';
import { getLibraryItems } from '../../../../../store/slices/yourLibrary';
import { GridItemComponent } from '../../../../Lists/list';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import useCompactLayout from '../../../../../utils/useCompactLayout';
import { getLibraryCollapsed, uiActions } from '../../../../../store/slices/ui';
import { LanguageButton } from '../Language';
import { LibraryLoginInfo } from './loginInfo';

const YourLibrary = ({ embedded = false }: { embedded?: boolean }) => {
  const collapsed = useAppSelector(getLibraryCollapsed);
  const user = useAppSelector((state) => !!state.auth.user);

  return (
    <div className={`Navigation-section library ${!collapsed ? 'open' : ''} ${embedded ? 'library-embedded' : ''}`}>
      {!embedded ? <LibraryTitle /> : null}
      {!collapsed && user ? <>
        <LibraryFilters />
        <SearchArea />
      </> : null}
      <div className="library-list-container">
        <div className="library-list">
          {!user ? <AnonymousContent /> : <LoggedContent />}
        </div>
      </div>
      {!user ? <LanguageButton /> : null}
    </div>
  );
};

const AnonymousContent = () => {
  return <LibraryLoginInfo />;
};

const LoggedContent = memo(() => {
  const isMobile = useCompactLayout();
  const dispatch = useAppDispatch();
  const items = useAppSelector(getLibraryItems);
  const collapsed = useAppSelector(getLibraryCollapsed);
  const view = useAppSelector((state) => state.yourLibrary.view);
  const search = useAppSelector((state) => state.yourLibrary.search);
  const [t] = useTranslation(['navbar']);

  const artistsStatus = useAppSelector((state) => state.yourLibrary.artistsStatus);
  const hasNoSearchResults = Boolean(search.trim()) && items.length === 0;

  return (
    <>
      {!items.length && artistsStatus === 'loading' ? <div className="library-empty-state"><Spin /><p>Loading your library…</p></div> : !items.length && !search.trim() ? <p className="library-empty-state">Your library is empty. Save music or follow artists on Spotify, then reload.</p> : hasNoSearchResults ? (
        <div className='library-search-empty'>
          <h3>
            {t("Couldn't find")} “{search.trim()}”
          </h3>
          <p>{t('Try searching again using a different spelling or keyword.')}</p>
        </div>
      ) : (
        <div
          className={`${collapsed ? 'collapsed' : ''} ${
            !collapsed && view === 'GRID' ? 'grid-view' : ''
          }`}
        >
          {items.map((item) => {
            if (collapsed) return <ListItemComponent key={item.id} item={item} />;

            return (
              <div
                key={item.id}
                onClick={isMobile ? () => dispatch(uiActions.collapseLibrary()) : undefined}
              >
                {view === 'LIST' ? <ListItemComponent key={item.id} item={item} /> : ''}
                {view === 'COMPACT' ? <CompactItemComponent key={item.id} item={item} /> : ''}
                {view === 'GRID' ? <GridItemComponent key={item.id} item={item} /> : ''}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
});

export default YourLibrary;

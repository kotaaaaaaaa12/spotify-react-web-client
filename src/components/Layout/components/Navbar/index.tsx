import { memo } from 'react';
import HistoryNavigation from './HistoryNavigation';
import Header from './Header';
import { Search } from './Search';

export const Navbar = memo(() => {
  return (
    <nav className='navbar' aria-label='Main navigation'>
      <div className='navbar-navigation'>
        <HistoryNavigation />
      </div>

      <div className='navbar-search' style={{ textAlign: 'center' }}>
        <Search />
      </div>

      <div className='navbar-actions'>
        <Header opacity={1} />
      </div>
    </nav>
  );
});

import { Space } from 'antd';

import ForwardBackwardsButton from './ForwardBackwardsButton';

import { memo } from 'react';
import { FaSpotify } from 'react-icons/fa6';
import { useNavigate } from 'react-router-dom';
import SettingsDrawer from '../../../SettingsDrawer';

const HistoryNavigation = memo(() => {
  const navigate = useNavigate();
  return (
    <Space>
      <button className="navbar-icon-button" aria-label="Home" title="Home" onClick={() => navigate('/')}><FaSpotify size={28} fill="white" /></button>
      <SettingsDrawer />

      <div className='navbar-history-buttons flex flex-row items-center gap-2 h-full'>
        <ForwardBackwardsButton flip />
        <ForwardBackwardsButton flip={false} />
      </div>
    </Space>
  );
});

export default HistoryNavigation;

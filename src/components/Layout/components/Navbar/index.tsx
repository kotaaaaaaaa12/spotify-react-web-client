import { Col, Row } from 'antd';
import { memo } from 'react';
import HistoryNavigation from './HistoryNavigation';
import Header from './Header';
import { Search } from './Search';

export const Navbar = memo(() => {
  return (
    <Row
      align='middle'
      gutter={[16, 16]}
      className='navbar'
      justify='space-between'
      style={{ margin: '0 5px' }}
    >
      <Col className='navbar-navigation'>
        <HistoryNavigation />
      </Col>

      <Col className='navbar-search' style={{ textAlign: 'center' }}>
        <Search />
      </Col>

      <Col className='navbar-actions'>
        <Header opacity={1} />
      </Col>
    </Row>
  );
});

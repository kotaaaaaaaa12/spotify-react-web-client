import { useEffect, useState } from 'react';

export default function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const change = () => setMobile(media.matches);
    media.addEventListener('change', change); change();
    return () => media.removeEventListener('change', change);
  }, []);
  return mobile;
}

import { useEffect, useState } from 'react';

export const compactLayoutQuery = '(max-width: 900px), (any-pointer: coarse)';
export default function useCompactLayout() {
  const [compact, setCompact] = useState(() => window.matchMedia(compactLayoutQuery).matches);
  useEffect(() => {
    const media = window.matchMedia(compactLayoutQuery);
    const change = () => setCompact(media.matches);
    media.addEventListener('change', change); change();
    return () => media.removeEventListener('change', change);
  }, []);
  return compact;
}

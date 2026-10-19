import { useLayoutEffect } from 'react';
import { takePendingScroll, useLocationKey, useRoute } from './lib/router';
import { Layout } from './components/Layout';
import { Home } from './pages/Home';
import { Profile } from './pages/Profile';
import { Thread } from './pages/Thread';
import { Tag } from './pages/Tag';
import { Search } from './pages/Search';
import { Explore } from './pages/Explore';
import { About } from './pages/About';
import { NotFound } from './pages/NotFound';

function Page() {
  const route = useRoute();
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'profile':
      return <Profile key={route.handle} handle={route.handle} tab={route.tab} />;
    case 'post':
      return <Thread key={route.id} id={route.id} />;
    case 'tag':
      return <Tag key={route.tag} tag={route.tag} />;
    case 'search':
      return <Search q={route.q} type={route.type} />;
    case 'explore':
      return <Explore />;
    case 'about':
      return <About />;
    default:
      return <NotFound />;
  }
}

export function App() {
  const route = useRoute();
  const key = useLocationKey();
  useLayoutEffect(() => {
    const y = takePendingScroll();
    if (y === null) return;
    window.scrollTo(0, y);
    if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
  }, [key]);
  return (
    <Layout route={route}>
      <Page />
    </Layout>
  );
}

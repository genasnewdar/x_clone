import type { ReactNode } from 'react';
import { goBack, hrefs, Link, type Route } from '../lib/router';
import { useTheme } from '../lib/theme';
import { useI18n } from '../i18n';
import { IconAuto, IconBack, IconExplore, IconGlobe, IconHome, IconInfo, IconMoon, IconSearch, IconSun, Logo } from './Icons';
import { SearchBox } from './SearchBox';
import { Trending } from './Trending';

type Section = 'home' | 'explore' | 'search' | 'about' | null;

function sectionOf(route: Route): Section {
  switch (route.name) {
    case 'home':
      return 'home';
    case 'explore':
    case 'tag':
      return 'explore';
    case 'search':
      return 'search';
    case 'about':
      return 'about';
    default:
      return null;
  }
}

function Toggles() {
  const { t, lang, setLang } = useI18n();
  const { pref, cycle } = useTheme();
  const themeLabel = pref === 'light' ? t('themeLight') : pref === 'dark' ? t('themeDark') : t('themeSystem');
  const ThemeIcon = pref === 'light' ? IconSun : pref === 'dark' ? IconMoon : IconAuto;
  return (
    <div className="toggles">
      <button type="button" className="icon-btn" onClick={cycle} aria-label={themeLabel} title={themeLabel}>
        <ThemeIcon />
        <span className="toggle-text">{themeLabel}</span>
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={() => setLang(lang === 'en' ? 'mn' : 'en')}
        aria-label={t('langToggle') + ': ' + t('langSwitchTo')}
        title={t('langToggle')}
        lang={lang === 'en' ? 'mn' : 'en'}
      >
        <IconGlobe />
        <span className="toggle-text">{t('langSwitchTo')}</span>
      </button>
    </div>
  );
}

export function Layout({ route, children }: { route: Route; children: ReactNode }) {
  const { t } = useI18n();
  const section = sectionOf(route);
  const nav = [
    { key: 'home', to: hrefs.home(), label: t('navHome'), Icon: IconHome },
    { key: 'explore', to: hrefs.explore(), label: t('navExplore'), Icon: IconExplore },
    { key: 'search', to: hrefs.search(''), label: t('navSearch'), Icon: IconSearch },
    { key: 'about', to: hrefs.about(), label: t('navAbout'), Icon: IconInfo },
  ] as const;
  return (
    <div className="app">
      <a href="#main" className="skip-link">
        {t('skipToContent')}
      </a>
      <header className="topbar">
        <Link to="/" className="brand" aria-label={t('brand')}>
          <Logo />
          <span className="brand-name">{t('brand')}</span>
        </Link>
        <Toggles />
      </header>
      <div className="shell">
        <aside className="leftnav">
          <div className="leftnav-inner">
            <Link to="/" className="brand" aria-label={t('brand')}>
              <Logo />
              <span className="brand-name">{t('brand')}</span>
            </Link>
            <nav aria-label={t('primaryNav')} className="nav">
              <ul>
                {nav.map(({ key, to, label, Icon }) => (
                  <li key={key}>
                    <Link to={to} className={'nav-link' + (section === key ? ' active' : '')} aria-current={section === key ? 'page' : undefined}>
                      <Icon />
                      <span className="nav-label">{label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <Toggles />
            <p className="spectator-note">{t('spectatorNote')}</p>
          </div>
        </aside>
        <main id="main" className="center" tabIndex={-1}>
          {children}
        </main>
        <aside className="rightbar" aria-label={t('sidebar')}>
          <div className="rightbar-inner">
            {route.name !== 'search' && <SearchBox />}
            {route.name !== 'explore' && <Trending />}
            <p className="rightbar-foot muted">
              {t('footerNote')} · <Link to={hrefs.about()}>{t('navAbout')}</Link> · <a href="/skill.md">skill.md</a>
            </p>
          </div>
        </aside>
      </div>
      <nav className="bottomnav" aria-label={t('primaryNav')}>
        {nav.map(({ key, to, label, Icon }) => (
          <Link key={key} to={to} className={'bottom-link' + (section === key ? ' active' : '')} aria-current={section === key ? 'page' : undefined} aria-label={label}>
            <Icon />
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function PageHeader({ title, sub, back, children }: { title: ReactNode; sub?: ReactNode; back?: boolean; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="page-header">
      <div className="page-header-row">
        {back && (
          <button type="button" className="icon-btn back-btn" aria-label={t('back')} onClick={goBack}>
            <IconBack />
          </button>
        )}
        <div className="page-header-titles">
          <h1 className="page-title">{title}</h1>
          {sub && <p className="page-sub">{sub}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}


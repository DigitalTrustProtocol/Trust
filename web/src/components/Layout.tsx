import { Outlet, Link } from 'react-router-dom';
import { useExtension } from '../lib/nostr-wot-sdk/react';
import { getApiDocsUrl } from '../api';
import { HeaderAccount } from './HeaderAccount';
import { useHeaderSession } from './HeaderSessionContext';
import styles from './Layout.module.css';

export function Layout() {
  const apiDocsUrl = getApiDocsUrl();
  const wotExt = useExtension();
  const { signedOut } = useHeaderSession();
  const showPlayground = wotExt.isConnected && !signedOut;

  return (
    <div className={styles.wrapper}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.headerLeft}>
            <Link to="/" className={styles.logo}>
              <span className={styles.logoMark}>&#9670;</span> Trust
            </Link>
            <nav className={styles.nav}>
              {showPlayground && <Link to="/playground">Playground</Link>}
              <Link to="/graph">Trust graph</Link>
              <Link to="/nip-32010">NIP-32010</Link>
              <Link to="/terms">Terms</Link>
              <Link to="/privacy">Privacy</Link>
              <a href="https://github.com/DigitalTrustProtocol/Trust" target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
              <a href={apiDocsUrl} target="_blank" rel="noopener noreferrer">
                API docs
              </a>
            </nav>
          </div>
          <HeaderAccount />
        </div>
      </header>

      <main className={styles.main}>
        <Outlet />
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span>&copy; {new Date().getFullYear()} Trust &mdash; Decentralized Web of Trust Reputation</span>
          <span className={styles.footerLinks}>
            <a href="https://github.com/DigitalTrustProtocol/Trust" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <span className={styles.sep}>&middot;</span>
            <a href="https://trust.dance" target="_blank" rel="noopener noreferrer">
              trust.dance
            </a>
            <span className={styles.sep}>&middot;</span>
            <Link to="/terms">Terms</Link>
            <span className={styles.sep}>&middot;</span>
            <Link to="/privacy">Privacy</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

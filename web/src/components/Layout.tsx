import { Outlet, Link } from 'react-router-dom';
import { getApiDocsUrl } from '../api';
import styles from './Layout.module.css';

export function Layout() {
  const apiDocsUrl = getApiDocsUrl();
  return (
    <div className={styles.wrapper}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link to="/" className={styles.logo}>
            <span className={styles.logoMark}>&#9670;</span> Trust
          </Link>
          <nav className={styles.nav}>
            <Link to="/graph">Graph</Link>
            <Link to="/nip-32010">NIP-32010</Link>
            <a href="https://github.com/DigitalTrustProtocol/Trust" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <a href={apiDocsUrl} target="_blank" rel="noopener noreferrer">
              API docs
            </a>
          </nav>
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
          </span>
        </div>
      </footer>
    </div>
  );
}

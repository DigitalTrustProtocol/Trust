import { Outlet, Link } from 'react-router-dom';
import styles from './Layout.module.css';

export function Layout() {
  return (
    <div className={styles.wrapper}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link to="/" className={styles.logo}>
            <span className={styles.logoMark}>&#9670;</span> Trust
          </Link>
          <nav className={styles.nav}>
            <a href="https://gitlab.com/keutmann/trust" target="_blank" rel="noopener noreferrer">
              GitLab
            </a>
            <a href="https://trust.dance" target="_blank" rel="noopener noreferrer">
              trust.dance
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
            <a href="https://gitlab.com/keutmann/trust" target="_blank" rel="noopener noreferrer">Source</a>
            <span className={styles.sep}>&middot;</span>
            <a href="https://trust.dance" target="_blank" rel="noopener noreferrer">trust.dance</a>
          </span>
        </div>
      </footer>
    </div>
  );
}

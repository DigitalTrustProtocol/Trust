import { useEffect, useRef, useState } from 'react';
import { useExtension, useWoTInstance } from '../lib/nostr-wot-sdk/react';
import { fetchKind0Profile } from '../lib/fetchNostrProfile';
import { useHeaderSession } from './HeaderSessionContext';
import styles from './Layout.module.css';

const WOT_EXTENSION_STORE =
  'https://chromewebstore.google.com/detail/nostr-wot/gfmefgdkmjpjinecjchlangpamhclhdo';

export function HeaderAccount() {
  const wot = useWoTInstance();
  const wotExt = useExtension();
  const { signedOut, signOut, signIn } = useHeaderSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const [pubkey, setPubkey] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [picture, setPicture] = useState<string | null>(null);

  useEffect(() => {
    if (!wot || !wotExt.isConnected || signedOut) {
      setPubkey(null);
      setDisplayName(null);
      setPicture(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const pk = await wot.getMyPubkey();
        if (cancelled) return;
        setPubkey(pk);
        const meta = await fetchKind0Profile(pk);
        if (cancelled) return;
        if (meta) {
          setDisplayName(meta.displayName || meta.name || null);
          setPicture(meta.picture || null);
        } else {
          setDisplayName(null);
          setPicture(null);
        }
      } catch {
        if (!cancelled) {
          setPubkey(null);
          setDisplayName(null);
          setPicture(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [wot, wotExt.isConnected, signedOut]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const onConnectClick = () => {
    signIn();
    wotExt.refresh();
  };

  if (wotExt.isChecking) {
    return (
      <div className={styles.headerAccount} aria-live="polite">
        <span className={styles.authMuted}>Checking extension…</span>
      </div>
    );
  }

  if (wotExt.isConnected && !signedOut && pubkey) {
    const label =
      displayName?.trim() ||
      (pubkey.length >= 16 ? `${pubkey.slice(0, 8)}…${pubkey.slice(-6)}` : pubkey);
    return (
      <div className={styles.headerAccount}>
        <div className={styles.authDropdownWrap} ref={wrapRef}>
          <button
            type="button"
            className={styles.authMenuTrigger}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((o) => !o)}
          >
            {picture ? (
              <img src={picture} alt="" className={styles.authAvatar} width={32} height={32} />
            ) : (
              <span className={styles.authAvatarPlaceholder} aria-hidden />
            )}
            <span className={styles.authName}>{label}</span>
            <span className={styles.authChevron} aria-hidden>
              {menuOpen ? '▴' : '▾'}
            </span>
          </button>
          {menuOpen && (
            <ul className={styles.authMenu} role="menu">
              <li role="none">
                <button
                  type="button"
                  className={styles.authMenuItem}
                  role="menuitem"
                  onClick={() => {
                    signOut();
                    setMenuOpen(false);
                  }}
                >
                  Log out
                </button>
              </li>
            </ul>
          )}
        </div>
      </div>
    );
  }

  if (wotExt.isConnected && !signedOut && !pubkey) {
    return (
      <div className={styles.headerAccount}>
        <span className={styles.authMuted}>Loading account…</span>
      </div>
    );
  }

  return (
    <div className={styles.headerAccount}>
      <button type="button" className={styles.authBtn} onClick={onConnectClick}>
        Connect extension
      </button>
      <a
        className={styles.authLink}
        href={WOT_EXTENSION_STORE}
        target="_blank"
        rel="noopener noreferrer"
      >
        Get WoT
      </a>
    </div>
  );
}

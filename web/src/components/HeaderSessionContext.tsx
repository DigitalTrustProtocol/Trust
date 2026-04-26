import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

const STORAGE_KEY = 'trust-web-header-signed-out';

type HeaderSessionValue = {
  /** User chose Log out in the header; extension may still be present. */
  signedOut: boolean;
  signOut: () => void;
  signIn: () => void;
};

const HeaderSessionContext = createContext<HeaderSessionValue | null>(null);

export function HeaderSessionProvider({ children }: { children: ReactNode }) {
  const [signedOut, setSignedOut] = useState(
    () => typeof sessionStorage !== 'undefined' && sessionStorage.getItem(STORAGE_KEY) === '1',
  );

  const signOut = useCallback(() => {
    sessionStorage.setItem(STORAGE_KEY, '1');
    setSignedOut(true);
  }, []);

  const signIn = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setSignedOut(false);
  }, []);

  const value = useMemo(
    () => ({
      signedOut,
      signOut,
      signIn,
    }),
    [signedOut, signOut, signIn],
  );

  return <HeaderSessionContext.Provider value={value}>{children}</HeaderSessionContext.Provider>;
}

export function useHeaderSession(): HeaderSessionValue {
  const ctx = useContext(HeaderSessionContext);
  if (!ctx) {
    throw new Error('useHeaderSession must be used within HeaderSessionProvider');
  }
  return ctx;
}

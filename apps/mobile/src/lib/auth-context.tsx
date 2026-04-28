import { createContext, useContext } from 'react';

export type AuthRecord = {
  id: string;
  username?: string;
};

export type AuthRoute = 'login' | 'register';

type AuthContextValue = {
  authRecord: AuthRecord;
  logout: () => void;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const value = useContext(AuthContext);

  if (!value) {
    throw new Error('useAuth must be used inside AuthContext');
  }

  return value;
}

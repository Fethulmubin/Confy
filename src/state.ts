import { UserSession } from './types';

/**
 * In-memory active conversation sessions for multi-step wizards
 * (e.g. order creation, waiting for payment slip upload, adding users)
 */
export const userSessions = new Map<number, UserSession>();

export function getSession(userId: number): UserSession | undefined {
  return userSessions.get(userId);
}

export function setSession(userId: number, session: UserSession): void {
  userSessions.set(userId, session);
}

export function clearSession(userId: number): void {
  userSessions.delete(userId);
}

/**
 * Cache of known Telegram usernames mapped to numeric user details
 */
export interface KnownUser {
  id: number;
  name: string;
  username: string;
}

export const knownUsersByUsername = new Map<string, KnownUser>();

export function registerKnownUser(id: number, name: string, username?: string): void {
  if (username) {
    const clean = username.replace(/^@/, '').toLowerCase();
    knownUsersByUsername.set(clean, { id, name, username });
  }
}

export function getKnownUserByUsername(username: string): KnownUser | undefined {
  const clean = username.replace(/^@/, '').toLowerCase();
  return knownUsersByUsername.get(clean);
}
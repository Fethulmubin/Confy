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
 * In-memory active role selection for multi-role users
 */
export const activeUserRoles = new Map<number, import('./types').UserRole>();

export function getActiveRole(userId: number): import('./types').UserRole | undefined {
  return activeUserRoles.get(userId);
}

export function setActiveRole(userId: number, role: import('./types').UserRole): void {
  activeUserRoles.set(userId, role);
}

export function clearActiveRole(userId: number): void {
  activeUserRoles.delete(userId);
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
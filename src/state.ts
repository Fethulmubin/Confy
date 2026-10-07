import { UserSession } from './types';

/**
 * In-memory active conversation sessions for multi-step wizards
 * (e.g. order creation, waiting for payment slip upload)
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
export const userStep = new Map<number, string>();
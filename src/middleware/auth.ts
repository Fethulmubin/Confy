import { Context } from 'telegraf';
import { db } from '../supabase';
import { User, UserRole } from '../types';

/**
 * Verifies that the sender is a registered user.
 * If unauthorized, responds with access denied showing their Telegram ID.
 */
export async function authenticateUser(ctx: Context): Promise<User | null> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return null;

  try {
    const user = await db.getUser(telegramId);
    if (!user) {
      const deniedMessage =
        `⛔ *Access Denied*\n\n` +
        `Your Telegram ID is: \`${telegramId}\`\n\n` +
        `You are not registered in the system. Self-selection of roles is not permitted.\n` +
        `Please contact an administrator with your ID to request access.`;

      if (ctx.callbackQuery) {
        await ctx.answerCbQuery(
          `Access denied: Telegram ID ${telegramId} is not registered.`,
          { show_alert: true }
        );
      } else {
        await ctx.reply(deniedMessage, { parse_mode: 'Markdown' });
      }
      return null;
    }
    return user;
  } catch (err: any) {
    console.error(`[Auth] Error authenticating user ${telegramId}:`, err.message);
    const msg = '⚠️ Database authentication error. Please try again later or contact support.';
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(msg, { show_alert: true });
    } else {
      await ctx.reply(msg);
    }
    return null;
  }
}

/**
 * Restricts an inline button callback query to specific roles.
 * Alerts the user with answerCbQuery(show_alert = true) if unauthorized.
 */
export async function checkCallbackRole(
  ctx: Context,
  allowedRoles: UserRole[]
): Promise<User | null> {
  const telegramId = ctx.from?.id;
  if (!telegramId) {
    await ctx.answerCbQuery('Unauthorized: Missing user information.', {
      show_alert: true,
    });
    return null;
  }

  try {
    const user = await db.getUser(telegramId);
    if (!user) {
      await ctx.answerCbQuery(
        `Access denied: Your Telegram ID is ${telegramId}. You are not registered.`,
        { show_alert: true }
      );
      return null;
    }

    if (!allowedRoles.includes(user.role)) {
      const rolesStr = allowedRoles.map((r) => r.toUpperCase()).join(' or ');
      await ctx.answerCbQuery(
        `Access denied: ${rolesStr} action only. Your role is ${user.role.toUpperCase()}.`,
        { show_alert: true }
      );
      return null;
    }

    return user;
  } catch (err: any) {
    console.error('[Auth Callback] Error:', err.message);
    await ctx.answerCbQuery('Internal database error during authorization.', {
      show_alert: true,
    });
    return null;
  }
}

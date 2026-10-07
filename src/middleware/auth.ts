import { Context } from 'telegraf';
import { db } from '../supabase';
import { config } from '../config';
import { User, UserRole } from '../types';
import { registerKnownUser } from '../state';
import { escapeMarkdown } from '../utils';

/**
 * Verifies that the sender is a registered user.
 * If unauthorized, responds with access denied showing their Telegram ID and notifies the manager.
 */
export async function authenticateUser(ctx: Context): Promise<User | null> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return null;

  const rawName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'User';
  const username = ctx.from?.username;

  // Cache user details for username lookups
  registerKnownUser(telegramId, rawName, username);

  try {
    let user = await db.getUser(telegramId);

    // If not found by ID, check if manager pre-registered them by @username
    if (!user && username) {
      const preRegistered = await db.getUserByUsername(username);
      if (preRegistered) {
        try {
          user = await db.updateUserTelegramId(
            preRegistered.telegram_id,
            telegramId,
            rawName,
            username
          );
          console.log(`🔗 Successfully linked @${username} to Telegram ID ${telegramId} with role ${user.role}`);
        } catch (linkErr: any) {
          console.warn('[Auth] Could not link placeholder ID:', linkErr.message);
        }
      }
    }

    if (!user) {
      const usernameText = username ? `@${username}` : 'No username set';
      const deniedMessage =
        `⛔ *Access Denied*\n\n` +
        `👤 *Name:* ${escapeMarkdown(rawName)}\n` +
        `📱 *Username:* ${escapeMarkdown(usernameText)}\n` +
        `🆔 *Telegram ID:* \`${telegramId}\`\n\n` +
        `You are not registered in the system. Self-selection of roles is not permitted.\n` +
        `An access request has been sent to the Management team.`;

      if (ctx.callbackQuery) {
        await ctx.answerCbQuery(
          `Access denied: Telegram ID ${telegramId} is not registered.`,
          { show_alert: true }
        );
      } else {
        await ctx.reply(deniedMessage, { parse_mode: 'Markdown' });

        // Forward interactive access request to #Orders topic / Manager
        if (config.ordersChatId) {
          try {
            await ctx.telegram.sendMessage(
              config.ordersChatId,
              `🔔 *New Access Request*\n\n` +
              `👤 *Name:* ${escapeMarkdown(rawName)}\n` +
              `📱 *Username:* ${username ? `@${escapeMarkdown(username)}` : 'None'}\n` +
              `🆔 *Telegram ID:* \`${telegramId}\`\n\n` +
              `Tap a button below to approve and assign role:`,
              {
                parse_mode: 'Markdown',
                message_thread_id: config.ordersThreadId,
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: '💼 Sales', callback_data: `grant_role_${telegramId}_sales` },
                      { text: '📦 Store', callback_data: `grant_role_${telegramId}_store` },
                    ],
                    [
                      { text: '💳 Finance', callback_data: `grant_role_${telegramId}_finance` },
                      { text: '👔 Manager', callback_data: `grant_role_${telegramId}_manager` },
                    ],
                  ],
                },
              }
            );
          } catch (notifyErr: any) {
            console.warn('[Auth] Could not forward access request to manager:', notifyErr.message);
          }
        }
      }
      return null;
    }

    // Keep stored username fresh in Supabase if changed
    if (username && user.username !== username) {
      db.upsertUser({
        telegram_id: user.telegram_id,
        name: user.name,
        role: user.role,
        username,
      }).catch(() => {});
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
    let user = await db.getUser(telegramId);
    if (!user && ctx.from?.username) {
      const preRegistered = await db.getUserByUsername(ctx.from.username);
      if (preRegistered) {
        try {
          const rawName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'User';
          user = await db.updateUserTelegramId(
            preRegistered.telegram_id,
            telegramId,
            rawName,
            ctx.from.username
          );
        } catch {}
      }
    }

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

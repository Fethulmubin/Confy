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
      const usernameText = username ? `@${username}` : 'የለውም';
      const deniedMessage =
        `⛔ *አልተፈቀደም (Access Denied)*\n\n` +
        `> 👤 *ስም:* ${escapeMarkdown(rawName)}\n` +
        `> 📱 *Username:* ${escapeMarkdown(usernameText)}\n` +
        `> 🆔 *Telegram ID:* \`${telegramId}\`\n\n` +
        `በሲስተሙ ውስጥ አልተመዘገቡም። እባክዎ ማናጀሩ ፈቃድ እስኪሰጥዎት ይጠብቁ።\n` +
        `የፈቃድ ጥያቄ ወደ ማናጀር ተልኳል።`;

      if (ctx.callbackQuery) {
        await ctx.answerCbQuery(
          `አልተፈቀደም: የእርስዎ Telegram ID (${telegramId}) አልተመዘገበም።`,
          { show_alert: true }
        );
      } else {
        await ctx.reply(deniedMessage, { parse_mode: 'Markdown' });

        // Forward interactive access request to #Orders topic / Manager
        if (config.ordersChatId) {
          try {
            await ctx.telegram.sendMessage(
              config.ordersChatId,
              `🔔 *አዲስ የፈቃድ ጥያቄ*\n\n` +
              `> 👤 *ስም:* ${escapeMarkdown(rawName)}\n` +
              `> 📱 *Username:* ${username ? `@${escapeMarkdown(username)}` : 'የለም'}\n` +
              `> 🆔 *Telegram ID:* \`${telegramId}\`\n\n` +
              `ሚና መርጠው ለማጽደቅ ከታች ይጫኑ:`,
              {
                parse_mode: 'Markdown',
                message_thread_id: config.ordersThreadId,
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: '💼 ሴልስ', callback_data: `grant_role_${telegramId}_sales` },
                      { text: '📦 ስቶር', callback_data: `grant_role_${telegramId}_store` },
                    ],
                    [
                      { text: '💳 ፋይናንስ', callback_data: `grant_role_${telegramId}_finance` },
                      { text: '👔 ማናጀር', callback_data: `grant_role_${telegramId}_manager` },
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
        `አልተፈቀደም: Telegram ID ${telegramId} አልተመዘገበም።`,
        { show_alert: true }
      );
      return null;
    }

    // Manager can do anything across all departments
    const isManager = user.roles.includes('manager') || user.role === 'manager';
    const hasRole = allowedRoles.some((r) => user!.roles.includes(r) || user!.activeRole === r);

    if (!isManager && !hasRole) {
      const roleMap: Record<string, string> = {
        sales: 'ሴልስ',
        store: 'ስቶር',
        finance: 'ፋይናንስ',
        manager: 'ማናጀር',
      };
      const rolesStr = allowedRoles.map((r) => roleMap[r] || r).join(' ወይም ');
      const userRoleStr = roleMap[user.activeRole] || user.activeRole;
      await ctx.answerCbQuery(
        `ይህ ተግባር ለ ${rolesStr} ብቻ የተፈቀደ ነው። የእርስዎ ሚና ${userRoleStr} ነው።`,
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

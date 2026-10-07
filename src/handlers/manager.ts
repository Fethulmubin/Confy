import { Telegraf } from 'telegraf';
import { db } from '../supabase';
import { config } from '../config';
import { checkCallbackRole, authenticateUser } from '../middleware/auth';
import { escapeMarkdown, formatCurrency, formatTime } from '../utils';
import { UserRole } from '../types';

export function registerManagerHandlers(bot: Telegraf): void {
  // Callback: Approve order
  bot.action(/^approve_order_(\d+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return; // Alert sent inside checkCallbackRole

    const orderId = parseInt(ctx.match[1], 10);

    try {
      const order = await db.getOrder(orderId);
      if (!order) {
        await ctx.answerCbQuery(`Order #${orderId} not found.`, { show_alert: true });
        return;
      }

      if (order.status !== 'pending_approval') {
        await ctx.answerCbQuery(
          `Order #${orderId} is already '${order.status}'. Cannot approve.`,
          { show_alert: true }
        );
        return;
      }

      // 1. Update status in Supabase
      const updatedOrder = await db.updateOrderStatus(orderId, 'pending_dispatch');

      // 2. Fetch sales rep name for display
      const salesRep = await db.getUser(updatedOrder.sales_id);
      const repName = salesRep?.name || `Rep ID ${updatedOrder.sales_id}`;
      const timeStr = formatTime(new Date());

      // 3. Edit manager card in-place to remove buttons
      const updatedCard =
        `New Requisition: Order #${updatedOrder.id}\n` +
        `Sales Rep: ${escapeMarkdown(repName)} | Total: ${formatCurrency(updatedOrder.total_amount)}\n` +
        `Items: ${escapeMarkdown(updatedOrder.item_details)}\n\n` +
        `✅ *Approved by Manager* (${manager.name}) at ${timeStr}`;

      try {
        await ctx.editMessageText(updatedCard, { parse_mode: 'Markdown' });
      } catch (editErr: any) {
        console.warn('[Manager] Could not edit message text:', editErr.message);
      }

      await ctx.answerCbQuery(`Order #${orderId} approved successfully!`);

      // 4. Notify sales rep in direct private chat
      try {
        await bot.telegram.sendMessage(
          updatedOrder.sales_id,
          `✅ *Order #${updatedOrder.id} Approved!*\n\n` +
          `Manager *${manager.name}* approved your order for *${escapeMarkdown(updatedOrder.client_name)}*.\n` +
          `It has been forwarded to the Store for release.`,
          { parse_mode: 'Markdown' }
        );
      } catch (notifyErr: any) {
        console.warn(`[Manager] Failed to notify sales rep ${updatedOrder.sales_id}:`, notifyErr.message);
      }

      // 5. Dispatch fulfillment request to the #Store topic
      const storeMessage =
        `Order #${updatedOrder.id} — Approved for Release\n` +
        `Client: ${escapeMarkdown(updatedOrder.client_name)}\n` +
        `Items: ${escapeMarkdown(updatedOrder.item_details)}\n\n` +
        `Reply directly to this message with the signed store release receipt photo.`;

      await bot.telegram.sendMessage(
        config.storeChatId,
        storeMessage,
        {
          message_thread_id: config.storeThreadId,
        }
      );
    } catch (err: any) {
      console.error(`[Manager] Error approving order #${orderId}:`, err);
      await ctx.answerCbQuery('Database error during approval.', { show_alert: true });
    }
  });

  // Callback: Reject order
  bot.action(/^reject_order_(\d+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return; // Alert sent inside checkCallbackRole

    const orderId = parseInt(ctx.match[1], 10);

    try {
      const order = await db.getOrder(orderId);
      if (!order) {
        await ctx.answerCbQuery(`Order #${orderId} not found.`, { show_alert: true });
        return;
      }

      if (order.status !== 'pending_approval') {
        await ctx.answerCbQuery(
          `Order #${orderId} is already '${order.status}'. Cannot reject.`,
          { show_alert: true }
        );
        return;
      }

      // 1. Update status in Supabase to cancelled
      const updatedOrder = await db.updateOrderStatus(orderId, 'cancelled');

      // 2. Fetch sales rep info
      const salesRep = await db.getUser(updatedOrder.sales_id);
      const repName = salesRep?.name || `Rep ID ${updatedOrder.sales_id}`;
      const timeStr = formatTime(new Date());

      // 3. Edit manager card in-place to remove buttons
      const updatedCard =
        `New Requisition: Order #${updatedOrder.id}\n` +
        `Sales Rep: ${escapeMarkdown(repName)} | Total: ${formatCurrency(updatedOrder.total_amount)}\n` +
        `Items: ${escapeMarkdown(updatedOrder.item_details)}\n\n` +
        `❌ *Rejected by Manager* (${manager.name}) at ${timeStr}`;

      try {
        await ctx.editMessageText(updatedCard, { parse_mode: 'Markdown' });
      } catch (editErr: any) {
        console.warn('[Manager] Could not edit message text:', editErr.message);
      }

      await ctx.answerCbQuery(`Order #${orderId} rejected.`);

      // 4. Notify sales rep in direct private chat
      try {
        await bot.telegram.sendMessage(
          updatedOrder.sales_id,
          `❌ *Order #${updatedOrder.id} Rejected*\n\n` +
          `Manager *${manager.name}* rejected your requisition for *${escapeMarkdown(updatedOrder.client_name)}*.\n` +
          `Status: *CANCELLED*.`,
          { parse_mode: 'Markdown' }
        );
      } catch (notifyErr: any) {
        console.warn(`[Manager] Failed to notify sales rep ${updatedOrder.sales_id}:`, notifyErr.message);
      }
    } catch (err: any) {
      console.error(`[Manager] Error rejecting order #${orderId}:`, err);
      await ctx.answerCbQuery('Database error during rejection.', { show_alert: true });
    }
  });

  // =========================================================================
  // Manager User Management Commands
  // =========================================================================

  // /add_user <telegram_id> <role> <name...>
  bot.command('add_user', async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user) return;

    if (user.role !== 'manager') {
      await ctx.reply('⛔ Only Managers can add or manage users.');
      return;
    }

    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);

    if (parts.length < 4) {
      await ctx.reply(
        `ℹ️ *Usage:* \`/add_user <telegram_id> <role> <name>\`\n\n` +
        `*Roles allowed:* \`manager\`, \`store\`, \`finance\`, \`sales\`\n\n` +
        `*Example:* \`/add_user 987654321 sales Dawit Tadesse\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const targetId = parseInt(parts[1], 10);
    const targetRole = parts[2].toLowerCase() as UserRole;
    const targetName = parts.slice(3).join(' ');

    if (isNaN(targetId) || targetId <= 0) {
      await ctx.reply('⚠️ Invalid Telegram ID. Must be a positive integer.');
      return;
    }

    const validRoles: UserRole[] = ['manager', 'store', 'finance', 'sales'];
    if (!validRoles.includes(targetRole)) {
      await ctx.reply(
        `⚠️ Invalid role '${targetRole}'. Allowed roles: ${validRoles.join(', ')}`
      );
      return;
    }

    try {
      const saved = await db.upsertUser({
        telegram_id: targetId,
        role: targetRole,
        name: targetName,
      });

      await ctx.reply(
        `✅ *User Registered / Updated*\n\n` +
        `👤 *Name:* ${escapeMarkdown(saved.name)}\n` +
        `🆔 *Telegram ID:* \`${saved.telegram_id}\`\n` +
        `🔑 *Role:* *${saved.role.toUpperCase()}*\n\n` +
        `They can now message the bot directly with /start to begin.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err: any) {
      console.error('[Manager] Error adding user:', err);
      await ctx.reply(`⚠️ Failed to add user: ${err.message}`);
    }
  });

  // /remove_user <telegram_id>
  bot.command('remove_user', async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user) return;

    if (user.role !== 'manager') {
      await ctx.reply('⛔ Only Managers can remove users.');
      return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('ℹ️ Usage: `/remove_user <telegram_id>`', { parse_mode: 'Markdown' });
      return;
    }

    const targetId = parseInt(parts[1], 10);
    if (isNaN(targetId)) {
      await ctx.reply('⚠️ Invalid Telegram ID.');
      return;
    }

    if (targetId === user.telegram_id) {
      await ctx.reply('⚠️ You cannot remove yourself.');
      return;
    }

    try {
      await db.deleteUser(targetId);
      await ctx.reply(`✅ User \`${targetId}\` removed from the system.`, { parse_mode: 'Markdown' });
    } catch (err: any) {
      console.error('[Manager] Error deleting user:', err);
      await ctx.reply(`⚠️ Failed to remove user: ${err.message}`);
    }
  });

  // /users or /list_users
  const listUsersHandler = async (ctx: any) => {
    const user = await authenticateUser(ctx);
    if (!user) return;

    if (user.role !== 'manager') {
      await ctx.reply('⛔ Only Managers can view the user list.');
      return;
    }

    try {
      const allUsers = await db.getAllUsers();
      if (allUsers.length === 0) {
        await ctx.reply('No users registered in the database.');
        return;
      }

      let msg = `👥 *Registered Team Members (${allUsers.length})*\n\n`;

      const roleIcons: Record<string, string> = {
        manager: '👔',
        sales: '💼',
        store: '📦',
        finance: '💳',
      };

      for (const u of allUsers) {
        const icon = roleIcons[u.role] || '👤';
        msg += `${icon} *${escapeMarkdown(u.name)}* (\`${u.telegram_id}\`)\n   Role: *${u.role.toUpperCase()}*\n\n`;
      }

      msg += `_Add more: /add_user <id> <role> <name>_\n_Remove: /remove_user <id>_`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err: any) {
      console.error('[Manager] Error listing users:', err);
      await ctx.reply('⚠️ Failed to load user list.');
    }
  };

  bot.command('users', listUsersHandler);
  bot.command('list_users', listUsersHandler);
}

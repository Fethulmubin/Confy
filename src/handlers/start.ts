import { Telegraf, Markup } from 'telegraf';
import { authenticateUser } from '../middleware/auth';
import { clearSession } from '../state';

export function registerStartHandlers(bot: Telegraf): void {
  // /start command
  bot.start(async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user) return; // Access denied message handled by authenticateUser

    clearSession(user.telegram_id);

    let roleDescription = '';
    let keyboardMarkup: any = Markup.removeKeyboard();
    let inlineMarkup: any = undefined;

    switch (user.role) {
      case 'sales':
        roleDescription =
          'You are registered as a *Sales Representative*.\n' +
          '• Use /new_order or tap the button below to create an order.\n' +
          '• Use /my_orders to track status and submit payment slips.';
        keyboardMarkup = Markup.keyboard([
          ['➕ New Order', '📋 My Orders'],
        ]).resize();
        break;

      case 'manager':
        roleDescription =
          'You are registered as a *Manager*.\n' +
          '• Authorize incoming requisitions in the #Orders channel/topic.\n' +
          '• Tap the button below to open the *Team Management Dashboard* to add staff, change roles, or manage members.';
        keyboardMarkup = Markup.keyboard([
          ['👥 Manage Team'],
        ]).resize();
        inlineMarkup = Markup.inlineKeyboard([
          [Markup.button.callback('👥 Open Team Management Dashboard', 'team_dashboard')],
        ]);
        break;

      case 'store':
        roleDescription =
          'You are registered as *Store Staff*.\n' +
          '• Approved orders will arrive in the #Store channel/topic.\n' +
          '• Reply directly to release notices with the signed receipt photo.';
        break;

      case 'finance':
        roleDescription =
          'You are registered as a *Finance Analyst*.\n' +
          '• Dispatched orders with payment slips arrive in the #Finance channel/topic.\n' +
          '• Verify payments against bank records and *Confirm Paid* or *Flag Discrepancy*.';
        break;
    }

    const greeting =
      `👋 Welcome, *${user.name}*!\n\n` +
      `Your Role: *${user.role.toUpperCase()}*\n\n` +
      `${roleDescription}\n\n` +
      `Type /help at any time for guidance or /cancel to reset active actions.`;

    if (inlineMarkup) {
      await ctx.reply(greeting, {
        parse_mode: 'Markdown',
        ...keyboardMarkup,
      });
      await ctx.reply('👉 Manager Actions:', inlineMarkup);
    } else {
      await ctx.reply(greeting, {
        parse_mode: 'Markdown',
        ...keyboardMarkup,
      });
    }
  });

  // /help command
  bot.help(async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user) return;

    let helpText =
      `📖 *System Help & Instructions*\n\n` +
      `👤 *User:* ${user.name}\n` +
      `🔑 *Role:* ${user.role.toUpperCase()}\n\n`;

    if (user.role === 'sales') {
      helpText +=
        `*Sales Commands (Private Chat Only):*\n` +
        `• /new_order — Create and submit a new client order\n` +
        `• /my_orders — List your orders and submit payment slips\n` +
        `• /cancel — Cancel ongoing order creation or upload\n`;
    } else if (user.role === 'manager') {
      helpText +=
        `*Manager Actions:*\n` +
        `• Monitor the #Orders topic for new requisitions\n` +
        `• Tap *Approve* to release to the store or *Reject* to cancel\n` +
        `• /manage_team or tap '👥 Manage Team' to view staff, assign roles by @username, or revoke access\n`;
    } else if (user.role === 'store') {
      helpText +=
        `*Store Actions:*\n` +
        `• Monitor the #Store topic for approved releases\n` +
        `• Reply directly to release notices with a signed receipt photo\n` +
        `• The bot automatically delivers the receipt privately to the sales rep\n`;
    } else if (user.role === 'finance') {
      helpText +=
        `*Finance Actions:*\n` +
        `• Monitor the #Finance topic for payment slips\n` +
        `• Audit bank transactions and tap *Confirm Paid* or *Flag Discrepancy*\n`;
    }

    await ctx.reply(helpText, { parse_mode: 'Markdown' });
  });

  // /cancel command
  bot.command('cancel', async (ctx) => {
    if (ctx.from?.id) {
      clearSession(ctx.from.id);
    }
    await ctx.reply('🔄 Current action cancelled. Returning to main menu.');
  });
}

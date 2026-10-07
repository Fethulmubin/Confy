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
    let extraMarkup: any = Markup.removeKeyboard();

    switch (user.role) {
      case 'sales':
        roleDescription =
          'You are registered as a *Sales Representative*.\n' +
          '• Use /new_order or tap the button below to create an order.\n' +
          '• Use /my_orders to track status and submit payment slips.';
        extraMarkup = Markup.keyboard([
          ['➕ New Order', '📋 My Orders'],
        ]).resize();
        break;

      case 'manager':
        roleDescription =
          'You are registered as a *Manager*.\n' +
          '• You will receive requisitions in the #Orders channel/topic.\n' +
          '• You can [ Approve ] or [ Reject ] incoming requisitions.';
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
          '• Verify payments against bank records and [ Confirm Paid ] or [ Flag Discrepancy ].';
        break;
    }

    const greeting =
      `👋 Welcome, *${user.name}*!\n\n` +
      `Your Role: *${user.role.toUpperCase()}*\n\n` +
      `${roleDescription}\n\n` +
      `Type /help at any time for guidance or /cancel to reset active actions.`;

    await ctx.reply(greeting, {
      parse_mode: 'Markdown',
      ...extraMarkup,
    });
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
        `• Tap [ Approve ] to release to the store or [ Reject ] to cancel\n`;
    } else if (user.role === 'store') {
      helpText +=
        `*Store Actions:*\n` +
        `• Monitor the #Store topic for approved releases\n` +
        `• Reply directly to the release message with a signed receipt photo\n` +
        `• The bot automatically delivers the receipt privately to the sales rep\n`;
    } else if (user.role === 'finance') {
      helpText +=
        `*Finance Actions:*\n` +
        `• Monitor the #Finance topic for payment slips\n` +
        `• Audit bank transactions and tap [ Confirm Paid ] or [ Flag Discrepancy ]\n`;
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

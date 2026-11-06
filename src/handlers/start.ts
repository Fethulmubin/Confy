import { Telegraf, Markup } from 'telegraf';
import { authenticateUser } from '../middleware/auth';
import { clearSession, setActiveRole } from '../state';
import { UserRole } from '../types';

export function registerStartHandlers(bot: Telegraf): void {
  // Callback: Switch active role
  bot.action(/^switch_role_([a-z]+)$/, async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user) return;

    const chosenRole = ctx.match[1] as UserRole;
    const isManager = user.roles.includes('manager') || user.role === 'manager';

    if (!isManager && !user.roles.includes(chosenRole)) {
      await ctx.answerCbQuery(`You are not assigned the ${chosenRole.toUpperCase()} role.`);
      return;
    }

    setActiveRole(user.telegram_id, chosenRole);
    await ctx.answerCbQuery(`Switched active view to ${chosenRole.toUpperCase()}`);

    // Refresh dashboard for the new active role
    await showRoleDashboard(ctx, { ...user, activeRole: chosenRole });
  });

  // Helper to render role-specific dashboard
  async function showRoleDashboard(ctx: any, user: import('../types').User) {
    let roleDescription = '';
    let keyboardMarkup: any = Markup.removeKeyboard();
    let inlineMarkup: any = undefined;

    const isManager = user.roles.includes('manager') || user.role === 'manager';

    switch (user.activeRole) {
      case 'sales':
        roleDescription =
          'You are active as a *Sales Representative*.\n' +
          '• Use /new_order or tap the button below to create an order.\n' +
          '• Use /my_orders to track status and submit payment slips.';
        keyboardMarkup = Markup.keyboard([
          ['➕ New Order', '📋 My Orders'],
        ]).resize();
        break;

      case 'manager':
        roleDescription =
          'You are active as a *Manager* (Full System Access).\n' +
          '• Authorize incoming requisitions in the #Orders channel/topic.\n' +
          '• Audit and approve incoming payment slips (with full Finance access).\n' +
          '• Open the *Team Management Dashboard* to add staff, manage roles, or revoke access.\n' +
          '• As Manager, you have full privileges across Sales, Store, and Finance!';
        keyboardMarkup = Markup.keyboard([
          ['👥 Manage Team', '💳 Pending Payments'],
        ]).resize();
        inlineMarkup = Markup.inlineKeyboard([
          [Markup.button.callback('👥 Team Management Dashboard', 'team_dashboard')],
          [Markup.button.callback('💳 Audit Pending Payments', 'list_pending_audit')],
        ]);
        break;

      case 'store':
        roleDescription =
          'You are active as *Store Staff*.\n' +
          '• Approved orders will arrive in the #Store channel/topic.\n' +
          '• Reply directly to release notices with the signed receipt photo.';
        break;

      case 'finance':
        roleDescription =
          'You are active as a *Finance Analyst*.\n' +
          '• Dispatched orders with payment slips arrive in the #Finance channel/topic.\n' +
          '• Verify payments against bank records and *Confirm Paid* or *Flag Discrepancy*.\n' +
          '• Tap the button below or use /pending_payments to review payment slips.';
        keyboardMarkup = Markup.keyboard([
          ['💳 Pending Payments'],
        ]).resize();
        inlineMarkup = Markup.inlineKeyboard([
          [Markup.button.callback('💳 Audit Pending Payments', 'list_pending_audit')],
        ]);
        break;
    }

    // Role switcher inline buttons if user has multiple roles or is manager
    const availableRoles: UserRole[] = isManager
      ? ['manager', 'sales', 'store', 'finance']
      : user.roles;

    let switchButtons: any[] = [];
    if (availableRoles.length > 1) {
      const roleLabels: Record<UserRole, string> = {
        manager: '👔 Manager',
        sales: '💼 Sales',
        store: '📦 Store',
        finance: '💳 Finance',
      };
      switchButtons = availableRoles.map((r) => {
        const isCurrent = r === user.activeRole;
        return Markup.button.callback(
          `${isCurrent ? '🔘' : '⚪'} ${roleLabels[r]}`,
          `switch_role_${r}`
        );
      });
    }

    const greeting =
      `👋 Welcome, *${user.cleanName}*!\n\n` +
      `Active View: *${user.activeRole.toUpperCase()}*` +
      (availableRoles.length > 1 ? ` _(Assigned: ${user.roles.map((r) => r.toUpperCase()).join(', ')})_` : '') +
      `\n\n${roleDescription}\n\n` +
      `Type /help at any time for guidance or /cancel to reset active actions.`;

    // Combine inline buttons
    const inlineRows: any[] = [];
    if (inlineMarkup && inlineMarkup.reply_markup && inlineMarkup.reply_markup.inline_keyboard) {
      inlineRows.push(...inlineMarkup.reply_markup.inline_keyboard);
    }
    if (switchButtons.length > 0) {
      // Group role switcher buttons 2 per row
      for (let i = 0; i < switchButtons.length; i += 2) {
        inlineRows.push(switchButtons.slice(i, i + 2));
      }
    }

    const finalInlineMarkup = inlineRows.length > 0 ? Markup.inlineKeyboard(inlineRows) : undefined;

    if (finalInlineMarkup) {
      await ctx.reply(greeting, {
        parse_mode: 'Markdown',
        ...keyboardMarkup,
      });
      await ctx.reply(
        availableRoles.length > 1
          ? '🔄 *Choose Role View / Actions:*'
          : '👉 *Actions:*',
        {
          parse_mode: 'Markdown',
          ...finalInlineMarkup,
        }
      );
    } else {
      await ctx.reply(greeting, {
        parse_mode: 'Markdown',
        ...keyboardMarkup,
      });
    }
  }

  // /start command
  bot.start(async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user) return; // Access denied message handled by authenticateUser

    clearSession(user.telegram_id);
    await showRoleDashboard(ctx, user);
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

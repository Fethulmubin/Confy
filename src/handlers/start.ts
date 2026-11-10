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
      await ctx.answerCbQuery(`የ ${chosenRole.toUpperCase()} role አልተሰጠዎትም።`);
      return;
    }

    setActiveRole(user.telegram_id, chosenRole);
    await ctx.answerCbQuery(`ወደ ${chosenRole.toUpperCase()} ተቀይሯል`);

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
          'እርስዎ በ *Sales Representative* view ውስጥ ነዎት።\n' +
          '• አዲስ order ለመመዝገብ /new_order ይጠቀሙ ወይም ከታች ያለውን button ይጫኑ።\n' +
          '• የ order ሁኔታዎችን ለመከታተልና የባንክ Payment Slip ለመላክ /my_orders ይጠቀሙ።';
        keyboardMarkup = Markup.keyboard([
          ['➕ New Order', '📋 My Orders'],
        ]).resize();
        break;

      case 'manager':
        roleDescription =
          'እርስዎ በ *Manager* (ሙሉ System Access) ውስጥ ነዎት።\n' +
          '• በ #Orders topic ውስጥ የሚገቡ አዳዲስ order-ኦችን ያጽድቁ (Approve ያድርጉ)።\n' +
          '• የተላኩትን Payment Slip-ኦች audit በማድረግ ያረጋግጡ (Confirm Paid)።\n' +
          '• ሰራተኞችን ለማስተዳደርና Role ለመስጠት Team Dashboard ይጠቀሙ።\n' +
          '• እንደ Manager በሁሉም የ Sales, Store እና Finance ክፍሎች ሙሉ access አለዎት!';
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
          'እርስዎ በ *Store Staff* view ውስጥ ነዎት።\n' +
          '• Manager ያጸደቃቸው (Approved) order-ኦች በ #Store topic ይደርሳሉ።\n' +
          '• ዕቃውን ሲያስረክቡ የተፈረመበትን Store Receipt በፎቶ መልእክቱን reply በማድረግ ይላኩ።';
        break;

      case 'finance':
        roleDescription =
          'እርስዎ በ *Finance Analyst* view ውስጥ ነዎት።\n' +
          '• Payment Slip የተላከላቸው order-ኦች በ #Finance topic ይደርሳሉ።\n' +
          '• የባንክ ሂሳቡን በማረጋገጥ *Confirm Paid* ወይም *Flag Discrepancy* ይጫኑ።\n' +
          '• የተላኩትን ክፍያዎች ለማየት ከታች ያለውን button ወይም /pending_payments ይጠቀሙ።';
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

    const assignedText = availableRoles.length > 1
      ? `\n> 🔑 *የተሰጡዎት Roles:* ${user.roles.map((r) => r.toUpperCase()).join(', ')}`
      : '';

    const greeting =
      `👋 *እንኳን ደህና መጡ, ${user.cleanName}!*\n\n` +
      `> 🎯 *Active View:* *${user.activeRole.toUpperCase()}*` +
      assignedText +
      `\n\n${roleDescription}\n\n` +
      `💡 _መመሪያዎችን ለማየት /help ወይም የጀመሩትን Action ለማቋረጥ /cancel ይጠቀሙ።_`;

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
          ? '🔄 *የ Role ምርጫ / Actions:*'
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
      `📖 *የሲስተም መመሪያዎች (Help & Instructions)*\n\n` +
      `> 👤 *ስም:* ${user.name}\n` +
      `> 🔑 *Active Role:* ${user.role.toUpperCase()}\n\n`;

    if (user.role === 'sales') {
      helpText +=
        `*የ Sales ትእዛዞች (በ Bot የግል ቻት ብቻ):*\n` +
        `• /new_order — አዲስ የደንበኛ order መመዝገብ\n` +
        `• /my_orders — የእርስዎን order-ኦች ማየትና Payment Slip መላክ\n` +
        `• /cancel — የጀመሩትን order ወይም slip መላኪያ ማቋረጥ\n`;
    } else if (user.role === 'manager') {
      helpText +=
        `*የ Manager ስራዎች:*\n` +
        `• በ #Orders topic ውስጥ የሚገቡ አዳዲስ order-ኦችን *Approve* ወይም *Reject* ማድረግ\n` +
        `• /manage_team ወይም '👥 Manage Team' በመጫን ሰራተኞችን ማስተዳደርና role መስጠት\n` +
        `• /pending_payments በመጠቀም ያልተረጋገጡ የባንክ ክፍያዎችን audit ማድረግ\n`;
    } else if (user.role === 'store') {
      helpText +=
        `*የ Store ስራዎች:*\n` +
        `• በ #Store topic የተፈቀዱ order-ኦችን መከታተል\n` +
        `• ዕቃው ሲወጣ የተፈረመበትን Store Receipt ፎቶ መልእክቱን reply በማድረግ መላክ\n` +
        `• bot-ቱ ደረሰኙን ወዲያውኑ ለ Sales Rep በግል ይልካል\n`;
    } else if (user.role === 'finance') {
      helpText +=
        `*የ Finance ስራዎች:*\n` +
        `• በ #Finance topic የሚገቡ የባንክ Payment Slip-ኦችን መከታተል\n` +
        `• የባንክ ሂሳቡን በማረጋገጥ *Confirm Paid* ወይም *Flag Discrepancy* መጫን\n` +
        `• /pending_payments በማለት የሚጠብቁ ክፍያዎችን ማየት\n`;
    }

    await ctx.reply(helpText, { parse_mode: 'Markdown' });
  });

  // /cancel command
  bot.command('cancel', async (ctx) => {
    if (ctx.from?.id) {
      clearSession(ctx.from.id);
    }
    await ctx.reply('🔄 የተጀመረው Action ተሰርዟል። ወደ ዋናው Menu ተመልሰዋል።');
  });
}

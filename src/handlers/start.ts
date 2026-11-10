import { Telegraf, Markup } from 'telegraf';
import { authenticateUser } from '../middleware/auth';
import { clearSession, setActiveRole } from '../state';
import { UserRole } from '../types';

export function registerStartHandlers(bot: Telegraf): void {
  const roleLabels: Record<UserRole, string> = {
    manager: '👔 ማናጀር',
    sales: '💼 ሴልስ',
    store: '📦 ስቶር',
    finance: '💳 ፋይናንስ',
  };

  // Callback: Switch active role
  bot.action(/^switch_role_([a-z]+)$/, async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user) return;

    const chosenRole = ctx.match[1] as UserRole;
    const isManager = user.roles.includes('manager') || user.role === 'manager';

    if (!isManager && !user.roles.includes(chosenRole)) {
      await ctx.answerCbQuery(`የ ${roleLabels[chosenRole] || chosenRole} ፈቃድ አልተሰጠዎትም።`);
      return;
    }

    setActiveRole(user.telegram_id, chosenRole);
    await ctx.answerCbQuery(`ወደ ${roleLabels[chosenRole] || chosenRole} ተቀይሯል`);

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
          'እርስዎ በ *ሴልስ* ክፍል ውስጥ ነዎት።\n' +
          '• አዲስ ኦርደር ለመመዝገብ /new_order ይጠቀሙ ወይም ከታች ያለውን አዝራር ይጫኑ።\n' +
          '• የኦርደር ሁኔታዎችን ለመከታተልና የባንክ ስሊፕ ለመላክ /my_orders ይጠቀሙ።';
        keyboardMarkup = Markup.keyboard([
          ['➕ አዲስ ኦርደር', '📋 የኔ ኦርደሮች'],
        ]).resize();
        break;

      case 'manager':
        roleDescription =
          'እርስዎ በ *ማናጀር* (ሙሉ ሲስተም access) ውስጥ ነዎት።\n' +
          '• በ #Orders topic ውስጥ የሚገቡ አዳዲስ ኦርደሮችን ያጽድቁ።\n' +
          '• የተላኩትን ስሊፖች በማየት ክፍያ ያረጋግጡ።\n' +
          '• ሰራተኞችን ለማስተዳደርና ሚና ለመስጠት የሰራተኞች ማስተዳደሪያ ይጠቀሙ።\n' +
          '• እንደ ማናጀር በሁሉም የሴልስ፣ ስቶር እና ፋይናንስ ክፍሎች ሙሉ access አለዎት!';
        keyboardMarkup = Markup.keyboard([
          ['👥 ሰራተኞች አስተዳድር', '💳 ያልተረጋገጡ ክፍያዎች'],
        ]).resize();
        inlineMarkup = Markup.inlineKeyboard([
          [Markup.button.callback('👥 ሰራተኞች አስተዳድር', 'team_dashboard')],
          [Markup.button.callback('💳 ያልተረጋገጡ ክፍያዎች', 'list_pending_audit')],
        ]);
        break;

      case 'store':
        roleDescription =
          'እርስዎ በ *ስቶር* ክፍል ውስጥ ነዎት።\n' +
          '• ማናጀር ያጸደቃቸው ኦርደሮች በ #Store topic ይደርሳሉ።\n' +
          '• ዕቃውን ሲያስረክቡ የተፈረመበትን ደረሰኝ በፎቶ መልእክቱን reply በማድረግ ይላኩ።';
        break;

      case 'finance':
        roleDescription =
          'እርስዎ በ *ፋይናንስ* ክፍል ውስጥ ነዎት።\n' +
          '• ስሊፕ የተላከላቸው ኦርደሮች በ #Finance topic ይደርሳሉ።\n' +
          '• የባንክ ሂሳቡን በማረጋገጥ ክፍያ ያረጋግጡ ወይም ችግር ካለ ሪፖርት ያድርጉ።\n' +
          '• ያልተረጋገጡ ክፍያዎችን ለማየት ከታች ያለውን አዝራር ወይም /pending_payments ይጠቀሙ።';
        keyboardMarkup = Markup.keyboard([
          ['💳 ያልተረጋገጡ ክፍያዎች'],
        ]).resize();
        inlineMarkup = Markup.inlineKeyboard([
          [Markup.button.callback('💳 ያልተረጋገጡ ክፍያዎች', 'list_pending_audit')],
        ]);
        break;
    }

    // Role switcher inline buttons if user has multiple roles or is manager
    const availableRoles: UserRole[] = isManager
      ? ['manager', 'sales', 'store', 'finance']
      : user.roles;

    let switchButtons: any[] = [];
    if (availableRoles.length > 1) {
      switchButtons = availableRoles.map((r) => {
        const isCurrent = r === user.activeRole;
        return Markup.button.callback(
          `${isCurrent ? '🔘' : '⚪'} ${roleLabels[r]}`,
          `switch_role_${r}`
        );
      });
    }

    const assignedText = availableRoles.length > 1
      ? `\n> 🔑 *የተሰጡዎት ሚናዎች:* ${user.roles.map((r) => roleLabels[r] || r).join(', ')}`
      : '';

    const greeting =
      `👋 *እንኳን ደህና መጡ, ${user.cleanName}!*\n\n` +
      `> 🎯 *የአሁን ሚና:* *${roleLabels[user.activeRole] || user.activeRole}*` +
      assignedText +
      `\n\n${roleDescription}\n\n` +
      `💡 _መመሪያዎችን ለማየት /help ወይም የጀመሩትን ለማቋረጥ /cancel ይጠቀሙ።_`;

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
          ? '🔄 *የሚና ምርጫ:*'
          : '👉 *ተግባራት:*',
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
      `📖 *የሲስተም መመሪያዎች (መመሪያ)*\n\n` +
      `> 👤 *ስም:* ${user.name}\n` +
      `> 🔑 *የአሁን ሚና:* ${roleLabels[user.role] || user.role}\n\n`;

    if (user.role === 'sales') {
      helpText +=
        `*የሴልስ ትእዛዞች (በ Bot የግል ቻት ብቻ):*\n` +
        `• /new_order — አዲስ የደንበኛ ኦርደር መመዝገብ\n` +
        `• /my_orders — የእርስዎን ኦርደሮች ማየትና ስሊፕ መላክ\n` +
        `• /cancel — የጀመሩትን ኦርደር ወይም ስሊፕ መላኪያ ማቋረጥ\n`;
    } else if (user.role === 'manager') {
      helpText +=
        `*የማናጀር ስራዎች:*\n` +
        `• በ #Orders topic ውስጥ የሚገቡ አዳዲስ ኦርደሮችን ማጽደቅ ወይም ውድቅ ማድረግ\n` +
        `• /manage_team ወይም '👥 ሰራተኞች አስተዳድር' በመጫን ሰራተኞችን ማስተዳደርና ሚና መስጠት\n` +
        `• /pending_payments በመጠቀም ያልተረጋገጡ የባንክ ክፍያዎችን ማረጋገጥ\n`;
    } else if (user.role === 'store') {
      helpText +=
        `*የስቶር ስራዎች:*\n` +
        `• በ #Store topic የተፈቀዱ ኦርደሮችን መከታተል\n` +
        `• ዕቃው ሲወጣ የተፈረመበትን ደረሰኝ ፎቶ መልእክቱን reply በማድረግ መላክ\n` +
        `• bot-ቱ ደረሰኙን ወዲያውኑ ለሴልስ ሬፕ በግል ይልካል\n`;
    } else if (user.role === 'finance') {
      helpText +=
        `*የፋይናንስ ስራዎች:*\n` +
        `• በ #Finance topic የሚገቡ የባንክ ስሊፖችን መከታተል\n` +
        `• የባንክ ሂሳቡን በማረጋገጥ ክፍያ ማረጋገጥ ወይም ችግር ካለ ሪፖርት ማድረግ\n` +
        `• /pending_payments በማለት የሚጠብቁ ክፍያዎችን ማየት\n`;
    }

    await ctx.reply(helpText, { parse_mode: 'Markdown' });
  });

  // /cancel command
  bot.command('cancel', async (ctx) => {
    if (ctx.from?.id) {
      clearSession(ctx.from.id);
    }
    await ctx.reply('🔄 የተጀመረው ተግባር ተሰርዟል። ወደ ዋናው ገጽ ተመልሰዋል።');
  });
}

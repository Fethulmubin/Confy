import { Telegraf, Markup } from 'telegraf';
import { db } from '../supabase';
import { config } from '../config';
import { checkCallbackRole, authenticateUser } from '../middleware/auth';
import { escapeMarkdown, formatCurrency, formatTime } from '../utils';
import { UserRole } from '../types';
import { getSession, setSession, clearSession, getKnownUserByUsername, registerKnownUser } from '../state';

/**
 * Generates a deterministic negative ID from a username string
 * Used for pre-registering users before their first interaction with the bot.
 */
export function generatePlaceholderId(username: string): number {
  let hash = 5381;
  const clean = username.toLowerCase().trim();
  for (let i = 0; i < clean.length; i++) {
    hash = ((hash << 5) + hash) + clean.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return - (Math.abs(hash) % 1900000000 + 1000);
}

/**
 * Resolves a Telegram username or numeric ID into a valid user profile
 * Uses Telegram getChat, Supabase database, in-memory cache, or pre-registration placeholder
 */
async function resolveUserIdentity(
  bot: Telegraf,
  input: string
): Promise<{ id: number; username?: string; name: string } | null> {
  const parts = input.trim().split(/\s+/);
  const token = parts[0];
  const customName = parts.length > 1 ? parts.slice(1).join(' ') : undefined;

  // Case 1: Pure numeric Telegram ID
  if (/^-?\d+$/.test(token)) {
    const id = parseInt(token, 10);
    const existing = await db.getUser(id).catch(() => null);
    return {
      id,
      username: existing?.username || undefined,
      name: customName || existing?.name || `Staff Member`,
    };
  }

  // Case 2: Username string (@username or username)
  const cleanUsername = token.replace(/^@/, '').toLowerCase();

  // Step A: Query Telegram Bot API via getChat('@' + username)
  try {
    const chat: any = await bot.telegram.getChat('@' + cleanUsername);
    if (chat && chat.id) {
      const name =
        customName ||
        [chat.first_name, chat.last_name].filter(Boolean).join(' ') ||
        chat.title ||
        cleanUsername;
      return {
        id: chat.id,
        username: chat.username || cleanUsername,
        name,
      };
    }
  } catch (err: any) {
    console.log(`[Resolve] getChat(@${cleanUsername}) API check:`, err.message);
  }

  // Step B: Query Supabase database by username
  try {
    const dbUser = await db.getUserByUsername(cleanUsername);
    if (dbUser) {
      return {
        id: dbUser.telegram_id,
        username: dbUser.username || cleanUsername,
        name: customName || dbUser.name,
      };
    }
  } catch (err: any) {
    console.log(`[Resolve] DB lookup failed:`, err.message);
  }

  // Step C: Check in-memory cache of interacted users
  const cached = getKnownUserByUsername(cleanUsername);
  if (cached) {
    return {
      id: cached.id,
      username: cached.username || cleanUsername,
      name: customName || cached.name,
    };
  }

  // Case 3: Both username and ID provided in text, e.g. "@dawit 987654321" or "987654321 @dawit"
  if (parts.length >= 2) {
    const idPart = parts.find((p) => /^-?\d+$/.test(p));
    const userPart = parts.find((p) => p.startsWith('@') || /^[a-zA-Z0-9_]{3,}$/.test(p));
    if (idPart && userPart) {
      const id = parseInt(idPart, 10);
      const u = userPart.replace(/^@/, '');
      const remainingName = parts.filter((p) => p !== idPart && p !== userPart).join(' ');
      return {
        id,
        username: u,
        name: customName || remainingName || u,
      };
    }
  }

  // Step D: Pre-registration with deterministic placeholder ID for valid Telegram username
  if (/^[a-zA-Z0-9_]{3,32}$/.test(cleanUsername)) {
    const placeholderId = generatePlaceholderId(cleanUsername);
    return {
      id: placeholderId,
      username: cleanUsername,
      name: customName || `@${cleanUsername}`,
    };
  }

  return null;
}

export function registerManagerHandlers(bot: Telegraf): void {
  // =========================================================================
  // Requisition Authorization (Phase 2)
  // =========================================================================

  // Callback: Approve order
  bot.action(/^approve_order_(\d+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const orderId = parseInt(ctx.match[1], 10);

    try {
      const order = await db.getOrder(orderId);
      if (!order) {
        await ctx.answerCbQuery(`Order #${orderId} አልተገኘም።`, { show_alert: true });
        return;
      }

      if (order.status !== 'pending_approval') {
        await ctx.answerCbQuery(
          `Order #${orderId} አስቀድሞ '${order.status}' ላይ ነው። ማጽደቅ አይቻልም።`,
          { show_alert: true }
        );
        return;
      }

      const updatedOrder = await db.updateOrderStatus(orderId, 'pending_dispatch');
      const salesRep = await db.getUser(updatedOrder.sales_id);
      const repName = salesRep?.name || `Rep ID ${updatedOrder.sales_id}`;
      const timeStr = formatTime(new Date());

      const updatedCard =
        `📑 *Order #${updatedOrder.id} — Requisition Approved*\n\n` +
        `> 💼 *Sales Rep:* ${escapeMarkdown(repName)}\n` +
        `> 👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
        `> 📦 *Items:* ${escapeMarkdown(updatedOrder.item_details)}\n` +
        `> 💰 *Total:* *${formatCurrency(updatedOrder.total_amount)}*\n\n` +
        `✅ *በ Manager (${manager.name}) ጸድቋል (Approved)* በ ${timeStr}\n` +
        `📨 _ዕቃው እንዲወጣ ወደ Store topic ተልኳል።_`;

      try {
        await ctx.editMessageText(updatedCard, { parse_mode: 'Markdown' });
      } catch (editErr: any) {
        console.warn('[Manager] Could not edit message text:', editErr.message);
      }

      await ctx.answerCbQuery(`Order #${orderId} በስኬት ጸድቋል!`);

      // Notify sales rep
      try {
        await bot.telegram.sendMessage(
          updatedOrder.sales_id,
          `✅ *Order #${updatedOrder.id} ጸድቋል (Approved)!*\n\n` +
          `> 👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
          `> 👔 *ያጸደቀው Manager:* ${manager.name}\n` +
          `> 📦 *Status:* ለ Dispatch ወደ Store ተላልፏል\n\n` +
          `_የ Store ሰራተኛ ዕቃውን አዘጋጅቶ Store Receipt ይልካል።_`,
          { parse_mode: 'Markdown' }
        );
      } catch (notifyErr: any) {
        console.warn(`[Manager] Failed to notify sales rep ${updatedOrder.sales_id}:`, notifyErr.message);
      }

      // Dispatch to #Store topic
      const storeMessage =
        `📦 *Order #${updatedOrder.id} — እንዲወጣ ተፈቅዷል (Approved for Release)*\n\n` +
        `> 👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
        `> 📋 *Items:* ${escapeMarkdown(updatedOrder.item_details)}\n\n` +
        `📸 *Action:* ይህን መልእክት reply በማድረግ የተፈረመበትን Store Receipt ፎቶ ይላኩ።\n` +
        `💡 *ማስታወሻ:* የጭነት ወይም የጉልበት ወጪ ካለ በ caption ላይ ይጥቀሱ (ምሳሌ: \`ጭነት: 300, ጉልበት: 150\`)።`;

      await bot.telegram.sendMessage(
        config.storeChatId,
        storeMessage,
        {
          parse_mode: 'Markdown',
          message_thread_id: config.storeThreadId,
        }
      );
    } catch (err: any) {
      console.error(`[Manager] Error approving order #${orderId}:`, err);
      await ctx.answerCbQuery('Order በማጽደቅ ሂደት ላይ የ database ስህተት አጋጥሟል።', { show_alert: true });
    }
  });

  // Callback: Reject order
  bot.action(/^reject_order_(\d+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const orderId = parseInt(ctx.match[1], 10);

    try {
      const order = await db.getOrder(orderId);
      if (!order) {
        await ctx.answerCbQuery(`Order #${orderId} አልተገኘም።`, { show_alert: true });
        return;
      }

      if (order.status !== 'pending_approval') {
        await ctx.answerCbQuery(
          `Order #${orderId} አስቀድሞ '${order.status}' ላይ ነው። Cancel ማድረግ አይቻልም።`,
          { show_alert: true }
        );
        return;
      }

      const updatedOrder = await db.updateOrderStatus(orderId, 'cancelled');
      const salesRep = await db.getUser(updatedOrder.sales_id);
      const repName = salesRep?.name || `Rep ID ${updatedOrder.sales_id}`;
      const timeStr = formatTime(new Date());

      const updatedCard =
        `📑 *Order #${updatedOrder.id} — Requisition Rejected*\n\n` +
        `> 💼 *Sales Rep:* ${escapeMarkdown(repName)}\n` +
        `> 👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
        `> 💰 *Total:* ${formatCurrency(updatedOrder.total_amount)}\n\n` +
        `❌ *በ Manager (${manager.name}) ተሰርዟል (Rejected)* በ ${timeStr}`;

      try {
        await ctx.editMessageText(updatedCard, { parse_mode: 'Markdown' });
      } catch (editErr: any) {
        console.warn('[Manager] Could not edit message text:', editErr.message);
      }

      await ctx.answerCbQuery(`Order #${orderId} ተሰርዟል (Rejected)።`);

      try {
        await bot.telegram.sendMessage(
          updatedOrder.sales_id,
          `❌ *Order #${updatedOrder.id} አልጸደቀም (Rejected)*\n\n` +
          `> 👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
          `> 👔 *ያየው Manager:* ${manager.name}\n` +
          `> 🚫 *Status:* CANCELLED`,
          { parse_mode: 'Markdown' }
        );
      } catch (notifyErr: any) {
        console.warn(`[Manager] Failed to notify sales rep ${updatedOrder.sales_id}:`, notifyErr.message);
      }
    } catch (err: any) {
      console.error(`[Manager] Error rejecting order #${orderId}:`, err);
      await ctx.answerCbQuery('Order በመሰረዝ ሂደት ላይ የ database ስህተት አጋጥሟል።', { show_alert: true });
    }
  });

  // =========================================================================
  // 1-Click Access Request Approval (from /start by unauthorized staff)
  // =========================================================================

  bot.action(/^grant_role_(\d+)_([a-z]+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    const assignedRole = ctx.match[2] as UserRole;

    try {
      const existing = await db.getUser(targetId);
      const name = existing?.name || `Staff Member`;
      const username = existing?.username || undefined;

      const saved = await db.upsertUser({
        telegram_id: targetId,
        role: assignedRole,
        name,
        username,
      });

      await ctx.answerCbQuery(`Access ተፈቅዷል! እንደ ${assignedRole.toUpperCase()} ተመድቧል።`);

      try {
        await ctx.editMessageText(
          `✅ *የ Access ጥያቄ ጸድቋል*\n\n` +
          `👤 *ስም:* ${escapeMarkdown(saved.name)}\n` +
          `📱 *Username:* ${escapeMarkdown(saved.username ? '@' + saved.username : 'የለም')}\n` +
          `🆔 *Telegram ID:* \`${saved.telegram_id}\`\n` +
          `🔑 *የተሰጠው Role:* *${saved.role.toUpperCase()}*\n` +
          `በ Manager ${manager.name} ጸድቋል በ ${formatTime(new Date())}`,
          { parse_mode: 'Markdown' }
        );
      } catch {}

      // Notify the approved employee directly
      try {
        await bot.telegram.sendMessage(
          targetId,
          `🎉 *Access ተፈቅዶልዎታል!*\n\n` +
          `Manager *${manager.name}* ፈቃድ ሰጥተዎታል: *${assignedRole.toUpperCase()}* Role ተመድበዋል።\n\n` +
          `Bot-ቱን ለመጠቀም /start ይጫኑ።`,
          { parse_mode: 'Markdown' }
        );
      } catch (dmErr: any) {
        console.warn(`[Manager] Could not send DM to newly approved user ${targetId}:`, dmErr.message);
      }
    } catch (err: any) {
      console.error('[Manager] Error granting access:', err);
      await ctx.answerCbQuery('የሰራተኛውን Role በ database ውስጥ በማስቀመጥ ላይ ስህተት አጋጥሟል።', { show_alert: true });
    }
  });

  // =========================================================================
  // Interactive Team Management Menu
  // =========================================================================

  async function sendTeamDashboard(ctx: any, isEdit = false) {
    const user = await authenticateUser(ctx);
    if (!user || user.role !== 'manager') return;

    try {
      const allUsers = await db.getAllUsers();
      const text =
        `👥 *የ Team Dashboard*\n\n` +
        `> 👥 *የተመዘገቡ ሰራተኞች:* *${allUsers.length}*\n\n` +
        `ሰራተኞችን ለማየት፣ አዲስ ለመጨመር ወይም Role ለመቀየር ከታች ይምረጡ:`;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('📋 የሰራተኞች ዝርዝር (All Staff)', 'team_list_all'),
          Markup.button.callback('➕ አዲስ ሰራተኛ ጨምር (Add Staff)', 'team_start_add'),
        ],
      ]);

      if (isEdit && ctx.callbackQuery) {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
      } else {
        await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
      }
    } catch (err: any) {
      console.error('[Manager] Error loading dashboard:', err);
      await ctx.reply('⚠️ Team Dashboard በመክፈት ላይ ስህተት አጋጥሟል።');
    }
  }

  bot.command('team', (ctx) => sendTeamDashboard(ctx, false));
  bot.command('manage_team', (ctx) => sendTeamDashboard(ctx, false));
  bot.command('users', (ctx) => sendTeamDashboard(ctx, false));
  bot.command('list_users', (ctx) => sendTeamDashboard(ctx, false));
  bot.hears('👥 Manage Team', (ctx) => sendTeamDashboard(ctx, false));
  bot.hears('👥 Team Members', (ctx) => sendTeamDashboard(ctx, false));

  // Callback: Return to main team dashboard
  bot.action('team_dashboard', async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;
    await ctx.answerCbQuery();
    await sendTeamDashboard(ctx, true);
  });

  // Callback: List all staff with interactive member buttons
  bot.action('team_list_all', async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    try {
      const allUsers = await db.getAllUsers();
      if (allUsers.length === 0) {
        await ctx.answerCbQuery('ምንም የተመዘገበ ሰራተኛ የለም።');
        return;
      }

      const roleBadges: Record<string, string> = {
        manager: '👔 MGR',
        sales: '💼 SALES',
        store: '📦 STORE',
        finance: '💳 FIN',
      };

      const buttons = allUsers.map((u) => {
        const badges = u.roles.map((r) => roleBadges[r] || r.toUpperCase()).join('/');
        const usernameLabel = u.username ? `@${u.username}` : `#${u.telegram_id}`;
        return [
          Markup.button.callback(
            `[${badges}] ${u.cleanName} (${usernameLabel})`,
            `team_view_user_${u.telegram_id}`
          ),
        ];
      });

      buttons.push([
        Markup.button.callback('➕ አዲስ ሰራተኛ ጨምር', 'team_start_add'),
        Markup.button.callback('⬅️ ተመለስ', 'team_dashboard'),
      ]);

      await ctx.editMessageText(
        `📋 *የተመዘገቡ ሰራተኞች (${allUsers.length})*\n\n` +
        `ሰራተኛውን ለማየት፣ role ለመቀየር ወይም ለማስወገድ ከታች ይጫኑ:`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(buttons),
        }
      );
      await ctx.answerCbQuery();
    } catch (err: any) {
      console.error('[Manager] Error listing users:', err);
      await ctx.answerCbQuery('የሰራተኞችን ዝርዝር በማምጣት ላይ ስህተት አጋጥሟል።', { show_alert: true });
    }
  });

  // Callback: View single user detail with Role change & Remove options
  bot.action(/^team_view_user_(-?\d+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    try {
      const targetUser = await db.getUser(targetId);
      if (!targetUser) {
        await ctx.answerCbQuery('ተጠቃሚው በ database ውስጥ አልተገኘም።', { show_alert: true });
        return;
      }

      const usernameStr = targetUser.username ? `@${targetUser.username}` : 'የለም';
      const idDisplay =
        targetUser.telegram_id > 0
          ? `\`${targetUser.telegram_id}\``
          : `_Pending_ (/start ሲጫኑ ይያያዛል)`;

      const isTargetManager = targetUser.role === 'manager' || targetUser.roles.includes('manager');
      const text =
        `👤 *የሰራተኛ መረጃ (Staff Details)*\n\n` +
        `• *ስም:* ${escapeMarkdown(targetUser.cleanName)}\n` +
        `• *Username:* ${escapeMarkdown(usernameStr)}\n` +
        `• *Telegram ID:* ${idDisplay}\n` +
        `• *የተሰጡ Roles:* *${targetUser.roles.map((r) => r.toUpperCase()).join(', ')}*` +
        (isTargetManager ? ` _(Manager ሙሉ access አለው)_` : '') +
        `\n\nምን ማድረግ ይፈልጋሉ?`;

      const buttons = isTargetManager
        ? [
            [Markup.button.callback('⬅️ ወደ ሰራተኞች ዝርዝር', 'team_list_all')],
          ]
        : [
            [
              Markup.button.callback('🔄 Role ቀይር (Manage Roles)', `team_prompt_role_${targetUser.telegram_id}`),
              Markup.button.callback('🗑️ Access ሰርዝ (Remove)', `team_confirm_remove_${targetUser.telegram_id}`),
            ],
            [Markup.button.callback('⬅️ ወደ ሰራተኞች ዝርዝር', 'team_list_all')],
          ];

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons),
      });
      await ctx.answerCbQuery();
    } catch (err: any) {
      console.error('[Manager] Error viewing user:', err);
      await ctx.answerCbQuery('የሰራተኛውን መረጃ በማምጣት ላይ ስህተት አጋጥሟል።', { show_alert: true });
    }
  });

  // Callback: Prompt role options for user
  bot.action(/^team_prompt_role_(-?\d+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    const targetUser = await db.getUser(targetId);
    if (!targetUser) {
      await ctx.answerCbQuery('ተጠቃሚው አልተገኘም።', { show_alert: true });
      return;
    }

    if (targetUser.role === 'manager' || targetUser.roles.includes('manager')) {
      await ctx.answerCbQuery(
        'Manager ሙሉ access ስላለው ሌላ role መቀየር አይቻልም።',
        { show_alert: true }
      );
      return;
    }

    const assignedRoles = targetUser.roles;
    const text =
      `🔄 *የ ${escapeMarkdown(targetUser.cleanName)} Role ማስተካከያ*\n\n` +
      `የአሁን Roles: *${assignedRoles.map((r) => r.toUpperCase()).join(', ')}*\n\n` +
      `Role ለመጨመር ወይም ለማንሳት ከታች ያሉትን ይጫኑ:`;

    const isSales = assignedRoles.includes('sales');
    const isStore = assignedRoles.includes('store');
    const isFinance = assignedRoles.includes('finance');

    const buttons = [
      [
        Markup.button.callback(
          `${isSales ? '✅' : '➕'} Sales Rep`,
          `team_toggle_${targetId}_sales`
        ),
        Markup.button.callback(
          `${isStore ? '✅' : '➕'} Store Staff`,
          `team_toggle_${targetId}_store`
        ),
      ],
      [
        Markup.button.callback(
          `${isFinance ? '✅' : '➕'} Finance Analyst`,
          `team_toggle_${targetId}_finance`
        ),
      ],
      [Markup.button.callback('⬅️ ተመለስ', `team_view_user_${targetId}`)],
    ];

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
    await ctx.answerCbQuery();
  });

  // Callback: Toggle role for user (multi-role management)
  bot.action(/^team_toggle_(-?\d+)_([a-z]+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    const toggledRole = ctx.match[2] as UserRole;

    try {
      const existing = await db.getUser(targetId);
      if (!existing) {
        await ctx.answerCbQuery('ተጠቃሚው አልተገኘም።', { show_alert: true });
        return;
      }

      if (existing.role === 'manager' || existing.roles.includes('manager')) {
        await ctx.answerCbQuery(
          'Manager ሙሉ access ስላለው ሌላ role መቀየር አይቻልም።',
          { show_alert: true }
        );
        return;
      }

      const currentRoles = new Set(existing.roles);
      if (currentRoles.has(toggledRole)) {
        if (currentRoles.size <= 1) {
          await ctx.answerCbQuery('ሰራተኛው ቢያንስ አንድ Role ሊኖረው ይገባል።', { show_alert: true });
          return;
        }
        currentRoles.delete(toggledRole);
      } else {
        currentRoles.add(toggledRole);
      }

      const newRolesList = Array.from(currentRoles);
      const newPrimaryRole = newRolesList[0];
      const newTaggedName = `${existing.cleanName} [${newRolesList.join(',')}]`;

      const updated = await db.upsertUser({
        telegram_id: targetId,
        name: newTaggedName,
        role: newPrimaryRole,
        username: existing.username,
      });

      await ctx.answerCbQuery(`Role ተቀይሯል: ${newRolesList.join(', ').toUpperCase()}`);

      // Refresh the role manage menu
      const isSales = newRolesList.includes('sales');
      const isStore = newRolesList.includes('store');
      const isFinance = newRolesList.includes('finance');

      const text =
        `🔄 *የ ${escapeMarkdown(updated.cleanName)} Role ማስተካከያ*\n\n` +
        `የአሁን Roles: *${newRolesList.map((r) => r.toUpperCase()).join(', ')}*\n\n` +
        `Role ለመጨመር ወይም ለማንሳት ከታች ያሉትን ይጫኑ:`;

      const buttons = [
        [
          Markup.button.callback(
            `${isSales ? '✅' : '➕'} Sales Rep`,
            `team_toggle_${targetId}_sales`
          ),
          Markup.button.callback(
            `${isStore ? '✅' : '➕'} Store Staff`,
            `team_toggle_${targetId}_store`
          ),
        ],
        [
          Markup.button.callback(
            `${isFinance ? '✅' : '➕'} Finance Analyst`,
            `team_toggle_${targetId}_finance`
          ),
        ],
        [Markup.button.callback('⬅️ ተመለስ', `team_view_user_${targetId}`)],
      ];

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons),
      });
    } catch (err: any) {
      console.error('[Manager] Error toggling role:', err);
      await ctx.answerCbQuery('Role በመቀየር ላይ የ database ስህተት አጋጥሟል።', { show_alert: true });
    }
  });

  // Callback: Execute single role assignment (legacy fallback)
  bot.action(/^team_assign_(-?\d+)_([a-z]+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    const newRole = ctx.match[2] as UserRole;

    try {
      const existing = await db.getUser(targetId);
      if (existing && (existing.role === 'manager' || existing.roles.includes('manager'))) {
        await ctx.answerCbQuery('Manager ሙሉ access ስላለው መቀየር አይቻልም።', { show_alert: true });
        return;
      }

      const name = existing?.cleanName || existing?.name || `Staff Member`;
      const username = existing?.username || null;

      const updated = await db.upsertUser({
        telegram_id: targetId,
        name: `${name} [${newRole}]`,
        role: newRole,
        username,
      });

      await ctx.answerCbQuery(`Role ወደ ${newRole.toUpperCase()} ተቀይሯል!`);

      // Notify the user in their private chat if their real Telegram ID is known
      if (targetId > 0) {
        try {
          await bot.telegram.sendMessage(
            targetId,
            `ℹ️ *የ Role ለውጥ*\n\n` +
            `Manager *${manager.name}* የእርስዎን Role ወደ *${newRole.toUpperCase()}* ቀይረውታል።\n` +
            `ዳሽቦርዱን ለማደስ /start ይጫኑ።`,
            { parse_mode: 'Markdown' }
          );
        } catch {}
      }

      // Return to user view
      const usernameStr = updated.username ? `@${updated.username}` : 'የለም';
      const idDisplay =
        updated.telegram_id > 0
          ? `\`${updated.telegram_id}\``
          : `_Pending_ (/start ሲጫኑ በራሱ ይያያዛል)`;

      await ctx.editMessageText(
        `✅ *ሰራተኛው ተመዝግቧል / Role ተስተካክሏል!*\n\n` +
        `• *ስም:* ${escapeMarkdown(updated.cleanName)}\n` +
        `• *Username:* ${escapeMarkdown(usernameStr)}\n` +
        `• *Telegram ID:* ${idDisplay}\n` +
        `• *የተሰጡ Roles:* *${updated.roles.map((r) => r.toUpperCase()).join(', ')}*\n\n` +
        `የተስተካከለው በ ${manager.name} በ ${formatTime(new Date())}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ ወደ ሰራተኞች ዝርዝር', 'team_list_all')],
            [Markup.button.callback('👥 Team Dashboard', 'team_dashboard')],
          ]),
        }
      );
    } catch (err: any) {
      console.error('[Manager] Error assigning role:', err);
      await ctx.answerCbQuery('Role በመመደብ ላይ የ database ስህተት አጋጥሟል።', { show_alert: true });
    }
  });

  // Callback: Confirm removal
  bot.action(/^team_confirm_remove_(-?\d+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    if (targetId === manager.telegram_id) {
      await ctx.answerCbQuery('ራስዎን ማስወገድ አይችሉም።', { show_alert: true });
      return;
    }

    const targetUser = await db.getUser(targetId);
    if (!targetUser) {
      await ctx.answerCbQuery('ተጠቃሚው አልተገኘም።', { show_alert: true });
      return;
    }

    const text =
      `⚠️ *የሰራተኛ ስረዛ ማረጋገጫ*\n\n` +
      `እርግጠኛ ነዎት *${escapeMarkdown(targetUser.name)}* (\`${targetUser.telegram_id}\`) ከሲስተም እንዲወገድ ይፈልጋሉ?\n` +
      `ሰራተኛው ወዲያውኑ የ bot access ያጣል።`;

    const buttons = [
      [
        Markup.button.callback('🗑️ አዎ ሰርዝ (Yes, Remove)', `team_do_remove_${targetId}`),
        Markup.button.callback('⬅️ ተመለስ (Cancel)', `team_view_user_${targetId}`),
      ],
    ];

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
    await ctx.answerCbQuery();
  });

  // Callback: Execute removal
  bot.action(/^team_do_remove_(-?\d+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    try {
      await db.deleteUser(targetId);
      await ctx.answerCbQuery('ሰራተኛው ተሰርዟል።');

      await ctx.editMessageText(
        `✅ *ሰራተኛው ተሰርዟል*\n\n` +
        `የ Telegram ID \`${targetId}\` ያለው ሰራተኛ access ተሰርዟል።`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ ወደ ሰራተኞች ዝርዝር', 'team_list_all')],
          ]),
        }
      );
    } catch (err: any) {
      console.error('[Manager] Error removing user:', err);
      await ctx.answerCbQuery('ተጠቃሚውን በመሰረዝ ላይ ስህተት አጋጥሟል።', { show_alert: true });
    }
  });

  // =========================================================================
  // Interactive "Add Staff Member" Wizard
  // =========================================================================

  bot.action('team_start_add', async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    setSession(manager.telegram_id, {
      type: 'add_user',
      draft: { step: 'waiting_identity' },
    });

    await ctx.answerCbQuery();

    const promptText =
      `➕ <b>አዲስ ሰራተኛ መመዝገቢያ</b>\n\n` +
      `እባክዎ የሰራተኛውን:\n` +
      `• <b>Telegram Username</b> (ምሳሌ: <code>@dawit_t</code>)\n` +
      `• ወይም <b>Telegram ID</b> (ምሳሌ: <code>987654321</code>)\n` +
      `• ወይም ሁለቱንም (ምሳሌ: <code>@dawit_t 987654321</code>) ይላኩ\n\n` +
      `<i>(አማራጭ: ስማቸውን ጨምረው መላክ ይችላሉ፣ ምሳሌ: <code>@dawit_t Dawit Tadesse</code>)</i>\n\n` +
      `ወይም Command ይጠቀሙ: <code>/add_user @username &lt;role&gt; [name]</code>`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ ተመለስ (Cancel)', 'team_dashboard')],
    ]);

    try {
      await ctx.editMessageText(promptText, {
        parse_mode: 'HTML',
        ...keyboard,
      });
    } catch (editErr: any) {
      console.warn('[Add Staff] editMessageText fallback:', editErr.message);
      try {
        await ctx.reply(promptText, {
          parse_mode: 'HTML',
          ...keyboard,
        });
      } catch (replyErr: any) {
        console.error('[Add Staff] reply fallback error:', replyErr.message);
      }
    }
  });

  // Handle text input during Add User wizard
  bot.on('text', async (ctx, next) => {
    const session = getSession(ctx.from.id);
    if (!session || session.type !== 'add_user') {
      return next();
    }

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      if (text === '/cancel') {
        clearSession(ctx.from.id);
        await ctx.reply('🔄 ሰራተኛ መመዝገብ ተሰርዟል።');
        return;
      }
      return next();
    }

    // Resolve user identity via Telegram API getChat, DB, cache, or username placeholder
    const resolved = await resolveUserIdentity(bot, text);

    if (!resolved) {
      let botUsername = 'the bot';
      try {
        const me = await bot.telegram.getMe();
        if (me.username) botUsername = `@${me.username}`;
      } catch {}

      await ctx.reply(
        `⚠️ የላኩት Username ወይም ID ትክክለኛ አይደለም: <code>${escapeMarkdown(text)}</code>\n\n` +
        `እባክዎ እንደዚህ ይላኩ:\n` +
        `• Username (ምሳሌ: <code>@dawit_t</code>)\n` +
        `• ID (ምሳሌ: <code>987654321</code>)\n\n` +
        `<i>(ለማቋረጥ /cancel ይበሉ)</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    clearSession(ctx.from.id);

    // Pre-save basic info in Supabase so username & ID are stored
    try {
      const existing = await db.getUser(resolved.id);
      await db.upsertUser({
        telegram_id: resolved.id,
        name: resolved.name,
        role: existing?.role || 'sales',
        username: resolved.username,
      });
    } catch (e: any) {
      console.warn('[Add User] Note on initial upsert:', e.message);
    }

    const idDisplay =
      resolved.id > 0
        ? `\`${resolved.id}\``
        : `_Pending_ (/start ሲጫኑ በራሱ ይያያዛል)`;

    const promptText =
      `👤 *ሰራተኛው ተለይቷል!*\n\n` +
      `• *ስም:* ${escapeMarkdown(resolved.name)}\n` +
      `• *Username:* ${escapeMarkdown(resolved.username ? '@' + resolved.username : 'የለም')}\n` +
      `• *Telegram ID:* ${idDisplay}\n\n` +
      `👇 *የሰራተኛውን Role ይምረጡ:*`;

    const buttons = [
      [
        Markup.button.callback('💼 Sales Rep', `team_assign_${resolved.id}_sales`),
        Markup.button.callback('📦 Store Staff', `team_assign_${resolved.id}_store`),
      ],
      [
        Markup.button.callback('💳 Finance Analyst', `team_assign_${resolved.id}_finance`),
        Markup.button.callback('👔 Manager', `team_assign_${resolved.id}_manager`),
      ],
      [Markup.button.callback('⬅️ ተመለስ (Cancel)', 'team_dashboard')],
    ];

    await ctx.reply(promptText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  });

  // Direct slash command: /add_user <username_or_id> <role> [name]
  bot.command('add_user', async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user || user.role !== 'manager') {
      await ctx.reply('⛔ ሰራተኛ መጨመር የሚችሉት Manager ብቻ ናቸው።');
      return;
    }

    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);

    if (parts.length < 3) {
      await ctx.reply(
        `ℹ️ <b>አጠቃቀም:</b> <code>/add_user &lt;@username_or_id&gt; &lt;role&gt; [name]</code>\n\n` +
        `<b>Roles:</b> <code>sales</code>, <code>store</code>, <code>finance</code>, <code>manager</code>\n\n` +
        `<b>ምሳሌዎች:</b>\n` +
        `• <code>/add_user @dawit_t sales Dawit Tadesse</code>\n` +
        `• <code>/add_user 987654321 store Abebe Kebede</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const identifier = parts[1];
    const roleArg = parts[2].toLowerCase() as UserRole;
    const customName = parts.length > 3 ? parts.slice(3).join(' ') : undefined;

    const validRoles: UserRole[] = ['manager', 'store', 'finance', 'sales'];
    if (!validRoles.includes(roleArg)) {
      await ctx.reply(`⚠️ ትክክለኛ ያልሆነ role '${roleArg}'። የተፈቀዱ: ${validRoles.join(', ')}`);
      return;
    }

    const resolved = await resolveUserIdentity(bot, `${identifier} ${customName || ''}`);
    if (!resolved) {
      await ctx.reply(
        `⚠️ ለ \`${identifier}\` ትክክለኛ Username ወይም Telegram ID ማግኘት አልተቻለም።\n` +
        `እባክዎ Username (@username) ወይም Telegram ID በትክክል ይላኩ።`
      );
      return;
    }

    const existingTarget = await db.getUser(resolved.id);
    if (existingTarget && (existingTarget.role === 'manager' || existingTarget.roles.includes('manager'))) {
      await ctx.reply('⛔ Manager ሙሉ የሲስተም access ስላለው ወደ ሌላ role መቀየር አይቻልም።');
      return;
    }

    try {
      const saved = await db.upsertUser({
        telegram_id: resolved.id,
        name: resolved.name,
        role: roleArg,
        username: resolved.username,
      });

      const idDisplay =
        saved.telegram_id > 0
          ? `\`${saved.telegram_id}\``
          : `_Pending_ (/start ሲጫኑ በራሱ ይያያዛል)`;

      await ctx.reply(
        `✅ *ሰራተኛው ተመዝግቦ ተፈቅዷል!*\n\n` +
        `👤 *ስም:* ${escapeMarkdown(saved.name)}\n` +
        `📱 *Username:* ${escapeMarkdown(saved.username ? '@' + saved.username : 'የለም')}\n` +
        `🆔 *Telegram ID:* ${idDisplay}\n` +
        `🔑 *Role:* *${saved.role.toUpperCase()}*\n\n` +
        `አሁን ሰራተኛው Bot-ቱን በ /start መጠቀም ይችላል።`,
        { parse_mode: 'Markdown' }
      );

      if (saved.telegram_id > 0) {
        try {
          await bot.telegram.sendMessage(
            saved.telegram_id,
            `🎉 *እንኳን ደህና መጡ!*\n\nበ Manager ${user.name} እንደ *${roleArg.toUpperCase()}* ተመዝግበዋል።\nስራ ለመጀመር /start ይጫኑ።`,
            { parse_mode: 'Markdown' }
          );
        } catch {}
      }
    } catch (err: any) {
      console.error('[Manager] Error adding user:', err);
      await ctx.reply(`⚠️ ሰራተኛውን መመዝገብ አልተቻለም: ${err.message}`);
    }
  });

  // Direct slash command: /remove_user <id_or_username>
  bot.command('remove_user', async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user || user.role !== 'manager') {
      await ctx.reply('⛔ ሰራተኛ ማስወገድ የሚችሉት Manager ብቻ ናቸው።');
      return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('ℹ️ አጠቃቀም: `/remove_user <telegram_id_or_username>`', { parse_mode: 'Markdown' });
      return;
    }

    const identifier = parts[1];
    let targetId: number = NaN;

    if (/^-?\d+$/.test(identifier)) {
      targetId = parseInt(identifier, 10);
    } else {
      const cleanUsername = identifier.replace(/^@/, '').trim().toLowerCase();
      const u = await db.getUserByUsername(cleanUsername);
      if (u) {
        targetId = u.telegram_id;
      }
    }

    if (isNaN(targetId) || targetId === user.telegram_id) {
      await ctx.reply('⚠️ ትክክለኛ ያልሆነ ID/Username ነው ወይም ራስዎን ማስወገድ አይችሉም።');
      return;
    }

    const targetUser = await db.getUser(targetId);
    if (targetUser && (targetUser.role === 'manager' || targetUser.roles.includes('manager'))) {
      await ctx.reply('⛔ Manager-ን ማስወገድ አይቻልም።');
      return;
    }

    try {
      await db.deleteUser(targetId);
      await ctx.reply(`✅ ተጠቃሚ \`${identifier}\` ከሲስተም ተወግዷል።`, { parse_mode: 'Markdown' });
    } catch (err: any) {
      console.error('[Manager] Error deleting user:', err);
      await ctx.reply(`⚠️ ተጠቃሚውን ማስወገድ አልተቻለም: ${err.message}`);
    }
  });
}

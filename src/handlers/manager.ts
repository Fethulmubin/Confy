import { Telegraf, Markup } from 'telegraf';
import { db } from '../supabase';
import { config } from '../config';
import { checkCallbackRole, authenticateUser } from '../middleware/auth';
import { escapeMarkdown, formatCurrency, formatTime } from '../utils';
import { UserRole } from '../types';
import { getSession, setSession, clearSession, getKnownUserByUsername, registerKnownUser } from '../state';

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

      const updatedOrder = await db.updateOrderStatus(orderId, 'pending_dispatch');
      const salesRep = await db.getUser(updatedOrder.sales_id);
      const repName = salesRep?.name || `Rep ID ${updatedOrder.sales_id}`;
      const timeStr = formatTime(new Date());

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

      // Notify sales rep
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

      // Dispatch to #Store topic
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
    if (!manager) return;

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

      const updatedOrder = await db.updateOrderStatus(orderId, 'cancelled');
      const salesRep = await db.getUser(updatedOrder.sales_id);
      const repName = salesRep?.name || `Rep ID ${updatedOrder.sales_id}`;
      const timeStr = formatTime(new Date());

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
  // 1-Click Access Request Approval (from /start by unauthorized staff)
  // =========================================================================

  bot.action(/^grant_role_(\d+)_([a-z]+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    const assignedRole = ctx.match[2] as UserRole;

    try {
      // Find known user info or fallback
      const existing = await db.getUser(targetId);
      const name = existing?.name || `Employee ${targetId}`;
      const username = existing?.username || undefined;

      const saved = await db.upsertUser({
        telegram_id: targetId,
        role: assignedRole,
        name,
        username,
      });

      await ctx.answerCbQuery(`Access granted! Assigned as ${assignedRole.toUpperCase()}.`);

      try {
        await ctx.editMessageText(
          `✅ *Access Request Approved*\n\n` +
          `👤 *Name:* ${escapeMarkdown(saved.name)}\n` +
          `🆔 *Telegram ID:* \`${saved.telegram_id}\`\n` +
          `🔑 *Role Assigned:* *${saved.role.toUpperCase()}*\n` +
          `Approved by Manager ${manager.name} at ${formatTime(new Date())}`,
          { parse_mode: 'Markdown' }
        );
      } catch {}

      // Notify the approved employee directly in their private chat
      try {
        await bot.telegram.sendMessage(
          targetId,
          `🎉 *Access Granted!*\n\n` +
          `Manager *${manager.name}* has approved your access and assigned you the role: *${assignedRole.toUpperCase()}*.\n\n` +
          `Please send /start to open your dashboard.`,
          { parse_mode: 'Markdown' }
        );
      } catch (dmErr: any) {
        console.warn(`[Manager] Could not send DM to newly approved user ${targetId}:`, dmErr.message);
      }
    } catch (err: any) {
      console.error('[Manager] Error granting access:', err);
      await ctx.answerCbQuery('Failed to update user role in database.', { show_alert: true });
    }
  });

  // =========================================================================
  // Interactive Team Management Menu
  // =========================================================================

  // Send or edit Team Management Dashboard
  async function sendTeamDashboard(ctx: any, isEdit = false) {
    const user = await authenticateUser(ctx);
    if (!user || user.role !== 'manager') return;

    try {
      const allUsers = await db.getAllUsers();
      const text =
        `👥 *Team Management Dashboard*\n\n` +
        `Current Registered Staff: *${allUsers.length}*\n\n` +
        `Choose an action below to manage team members and assign roles:`;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('📋 View All Staff', 'team_list_all'),
          Markup.button.callback('➕ Add Staff Member', 'team_start_add'),
        ],
      ]);

      if (isEdit && ctx.callbackQuery) {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
      } else {
        await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
      }
    } catch (err: any) {
      console.error('[Manager] Error loading dashboard:', err);
      await ctx.reply('⚠️ Error opening Team Management Dashboard.');
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
        await ctx.answerCbQuery('No users registered.');
        return;
      }

      const roleBadges: Record<string, string> = {
        manager: '👔 MGR',
        sales: '💼 SALES',
        store: '📦 STORE',
        finance: '💳 FIN',
      };

      const buttons = allUsers.map((u) => {
        const badge = roleBadges[u.role] || u.role.toUpperCase();
        const usernameLabel = u.username ? `@${u.username}` : `#${u.telegram_id}`;
        return [
          Markup.button.callback(
            `[${badge}] ${u.name} (${usernameLabel})`,
            `team_view_user_${u.telegram_id}`
          ),
        ];
      });

      buttons.push([
        Markup.button.callback('➕ Add New Staff', 'team_start_add'),
        Markup.button.callback('⬅️ Back', 'team_dashboard'),
      ]);

      await ctx.editMessageText(
        `📋 *Registered Staff Members (${allUsers.length})*\n\n` +
        `Tap on any employee below to view details, change their role, or remove them:`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(buttons),
        }
      );
      await ctx.answerCbQuery();
    } catch (err: any) {
      console.error('[Manager] Error listing users:', err);
      await ctx.answerCbQuery('Error loading staff list.', { show_alert: true });
    }
  });

  // Callback: View single user detail with Role change & Remove options
  bot.action(/^team_view_user_(\d+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    try {
      const targetUser = await db.getUser(targetId);
      if (!targetUser) {
        await ctx.answerCbQuery('User not found in database.', { show_alert: true });
        return;
      }

      const usernameStr = targetUser.username ? `@${targetUser.username}` : 'None';
      const text =
        `👤 *Staff Member Details*\n\n` +
        `• *Name:* ${escapeMarkdown(targetUser.name)}\n` +
        `• *Username:* ${escapeMarkdown(usernameStr)}\n` +
        `• *Telegram ID:* \`${targetUser.telegram_id}\`\n` +
        `• *Current Role:* *${targetUser.role.toUpperCase()}*\n\n` +
        `What would you like to do?`;

      const buttons = [
        [
          Markup.button.callback('🔄 Change Role', `team_prompt_role_${targetUser.telegram_id}`),
          Markup.button.callback('🗑️ Remove Access', `team_confirm_remove_${targetUser.telegram_id}`),
        ],
        [Markup.button.callback('⬅️ Back to Staff List', 'team_list_all')],
      ];

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons),
      });
      await ctx.answerCbQuery();
    } catch (err: any) {
      console.error('[Manager] Error viewing user:', err);
      await ctx.answerCbQuery('Error loading user.', { show_alert: true });
    }
  });

  // Callback: Prompt role options for user
  bot.action(/^team_prompt_role_(\d+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    const targetUser = await db.getUser(targetId);
    if (!targetUser) {
      await ctx.answerCbQuery('User not found.', { show_alert: true });
      return;
    }

    const text =
      `🔄 *Select New Role for ${escapeMarkdown(targetUser.name)}*\n\n` +
      `Current Role: *${targetUser.role.toUpperCase()}*\n\n` +
      `Tap a role below to reassign:`;

    const buttons = [
      [
        Markup.button.callback('💼 Sales Rep', `team_assign_${targetId}_sales`),
        Markup.button.callback('📦 Store Staff', `team_assign_${targetId}_store`),
      ],
      [
        Markup.button.callback('💳 Finance Analyst', `team_assign_${targetId}_finance`),
        Markup.button.callback('👔 Manager', `team_assign_${targetId}_manager`),
      ],
      [Markup.button.callback('⬅️ Cancel', `team_view_user_${targetId}`)],
    ];

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
    await ctx.answerCbQuery();
  });

  // Callback: Execute role reassignment
  bot.action(/^team_assign_(\d+)_([a-z]+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    const newRole = ctx.match[2] as UserRole;

    try {
      const existing = await db.getUser(targetId);
      if (!existing) {
        await ctx.answerCbQuery('User not found.', { show_alert: true });
        return;
      }

      const updated = await db.upsertUser({
        telegram_id: targetId,
        name: existing.name,
        role: newRole,
        username: existing.username,
      });

      await ctx.answerCbQuery(`Role updated to ${newRole.toUpperCase()}!`);

      // Notify the user in their private chat
      try {
        await bot.telegram.sendMessage(
          targetId,
          `ℹ️ *Role Updated*\n\n` +
          `Manager *${manager.name}* updated your system role to: *${newRole.toUpperCase()}*.\n` +
          `Send /start to refresh your menu.`,
          { parse_mode: 'Markdown' }
        );
      } catch {}

      // Return to user view
      const usernameStr = updated.username ? `@${updated.username}` : 'None';
      await ctx.editMessageText(
        `✅ *Role Updated Successfully!*\n\n` +
        `• *Name:* ${escapeMarkdown(updated.name)}\n` +
        `• *Username:* ${escapeMarkdown(usernameStr)}\n` +
        `• *Telegram ID:* \`${updated.telegram_id}\`\n` +
        `• *New Role:* *${updated.role.toUpperCase()}*\n\n` +
        `Updated by ${manager.name} at ${formatTime(new Date())}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Back to Staff List', 'team_list_all')],
          ]),
        }
      );
    } catch (err: any) {
      console.error('[Manager] Error assigning role:', err);
      await ctx.answerCbQuery('Database error updating role.', { show_alert: true });
    }
  });

  // Callback: Confirm removal
  bot.action(/^team_confirm_remove_(\d+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    if (targetId === manager.telegram_id) {
      await ctx.answerCbQuery('You cannot remove yourself.', { show_alert: true });
      return;
    }

    const targetUser = await db.getUser(targetId);
    if (!targetUser) {
      await ctx.answerCbQuery('User not found.', { show_alert: true });
      return;
    }

    const text =
      `⚠️ *Confirm Removal*\n\n` +
      `Are you sure you want to remove *${escapeMarkdown(targetUser.name)}* (\`${targetUser.telegram_id}\`)?\n` +
      `They will immediately lose access to all bot features.`;

    const buttons = [
      [
        Markup.button.callback('🗑️ Yes, Remove Access', `team_do_remove_${targetId}`),
        Markup.button.callback('⬅️ Cancel', `team_view_user_${targetId}`),
      ],
    ];

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
    await ctx.answerCbQuery();
  });

  // Callback: Execute removal
  bot.action(/^team_do_remove_(\d+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    try {
      await db.deleteUser(targetId);
      await ctx.answerCbQuery('User removed.');

      await ctx.editMessageText(
        `✅ *User Removed*\n\n` +
        `Access for Telegram ID \`${targetId}\` has been revoked.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Back to Staff List', 'team_list_all')],
          ]),
        }
      );
    } catch (err: any) {
      console.error('[Manager] Error removing user:', err);
      await ctx.answerCbQuery('Failed to delete user.', { show_alert: true });
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
    await ctx.reply(
      `➕ *Add New Team Member*\n\n` +
      `Please send the employee's:\n` +
      `• *Telegram Username* (e.g. \`@dawit_t\` or \`dawit_t\`)\n` +
      `• OR *Numeric Telegram ID* (e.g. \`987654321\`)\n\n` +
      `_(Optional: include their name after the username/ID, e.g. \`@dawit_t Dawit Tadesse\`)_\n\n` +
      `_(Type /cancel to abort)_`,
      { parse_mode: 'Markdown' }
    );
  });

  // Handle text input during Add User wizard
  bot.on('text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();

    const session = getSession(ctx.from.id);
    if (!session || session.type !== 'add_user') {
      return next();
    }

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next();

    const parts = text.split(/\s+/);
    const firstToken = parts[0];
    const customName = parts.length > 1 ? parts.slice(1).join(' ') : undefined;

    let targetId: number | null = null;
    let targetUsername: string | undefined = undefined;
    let resolvedName: string = customName || 'Staff Member';

    // 1. Check if numeric Telegram ID was provided
    if (/^\d+$/.test(firstToken)) {
      targetId = parseInt(firstToken, 10);
    } else {
      // 2. It's a username (e.g. @dawit or dawit)
      const cleanUsername = firstToken.replace(/^@/, '').toLowerCase();
      targetUsername = cleanUsername;

      // Check in-memory cache
      const cached = getKnownUserByUsername(cleanUsername);
      if (cached) {
        targetId = cached.id;
        if (!customName) resolvedName = cached.name;
      } else {
        // Check database
        try {
          const dbUser = await db.getUserByUsername(cleanUsername);
          if (dbUser) {
            targetId = dbUser.telegram_id;
            if (!customName) resolvedName = dbUser.name;
          }
        } catch {}
      }
    }

    if (!targetId) {
      await ctx.reply(
        `⚠️ Could not resolve Telegram ID for \`${escapeMarkdown(firstToken)}\`.\n\n` +
        `*Reason:* Telegram bots can only resolve usernames of users who have either sent /start to the bot or belong to the group.\n\n` +
        `👉 *To resolve this:*\n` +
        `1. Ask the employee to send /start to the bot, OR\n` +
        `2. Enter their *numeric Telegram ID* directly (e.g. \`987654321\`).\n\n` +
        `_(Type /cancel to exit)_`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    clearSession(ctx.from.id);

    // Prompt role assignment buttons
    const userLabel = targetUsername ? `@${targetUsername}` : `ID: ${targetId}`;
    const promptText =
      `👤 *Select Role for ${escapeMarkdown(resolvedName)}* (${escapeMarkdown(userLabel)})\n\n` +
      `Telegram ID: \`${targetId}\`\n\n` +
      `Tap a role below to assign and activate their account:`;

    const buttons = [
      [
        Markup.button.callback('💼 Sales Rep', `team_assign_${targetId}_sales`),
        Markup.button.callback('📦 Store Staff', `team_assign_${targetId}_store`),
      ],
      [
        Markup.button.callback('💳 Finance Analyst', `team_assign_${targetId}_finance`),
        Markup.button.callback('👔 Manager', `team_assign_${targetId}_manager`),
      ],
      [Markup.button.callback('⬅️ Cancel', 'team_dashboard')],
    ];

    // Pre-save basic name & username if existing record doesn't exist
    try {
      const existing = await db.getUser(targetId);
      if (!existing) {
        await db.upsertUser({
          telegram_id: targetId,
          name: resolvedName,
          role: 'sales', // temporary placeholder before click
          username: targetUsername,
        });
      }
    } catch {}

    await ctx.reply(promptText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  });

  // Legacy command: /add_user <id_or_username> <role> <name...>
  bot.command('add_user', async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user || user.role !== 'manager') {
      await ctx.reply('⛔ Only Managers can add users.');
      return;
    }

    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);

    if (parts.length < 3) {
      await ctx.reply(
        `ℹ️ *Usage:* \`/add_user <username_or_id> <role> [name]\`\n\n` +
        `*Roles:* \`sales\`, \`store\`, \`finance\`, \`manager\`\n\n` +
        `*Examples:*\n` +
        `• \`/add_user @dawit_t sales Dawit Tadesse\`\n` +
        `• \`/add_user 987654321 store Abebe Kebede\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const firstToken = parts[1];
    const targetRole = parts[2].toLowerCase() as UserRole;
    const customName = parts.length > 3 ? parts.slice(3).join(' ') : undefined;

    const validRoles: UserRole[] = ['manager', 'store', 'finance', 'sales'];
    if (!validRoles.includes(targetRole)) {
      await ctx.reply(`⚠️ Invalid role. Allowed: ${validRoles.join(', ')}`);
      return;
    }

    let targetId: number | null = null;
    let targetUsername: string | undefined = undefined;
    let resolvedName = customName || 'Staff Member';

    if (/^\d+$/.test(firstToken)) {
      targetId = parseInt(firstToken, 10);
    } else {
      const clean = firstToken.replace(/^@/, '').toLowerCase();
      targetUsername = clean;
      const cached = getKnownUserByUsername(clean);
      if (cached) {
        targetId = cached.id;
        if (!customName) resolvedName = cached.name;
      } else {
        const dbUser = await db.getUserByUsername(clean);
        if (dbUser) {
          targetId = dbUser.telegram_id;
          if (!customName) resolvedName = dbUser.name;
        }
      }
    }

    if (!targetId) {
      await ctx.reply(
        `⚠️ Could not resolve numeric ID for \`${firstToken}\`.\n` +
        `Please provide their numeric Telegram ID, or have them send /start to the bot first.`
      );
      return;
    }

    try {
      const saved = await db.upsertUser({
        telegram_id: targetId,
        name: resolvedName,
        role: targetRole,
        username: targetUsername,
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

  // Legacy command: /remove_user <id>
  bot.command('remove_user', async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user || user.role !== 'manager') {
      await ctx.reply('⛔ Only Managers can remove users.');
      return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('ℹ️ Usage: `/remove_user <telegram_id>`', { parse_mode: 'Markdown' });
      return;
    }

    const targetId = parseInt(parts[1], 10);
    if (isNaN(targetId) || targetId === user.telegram_id) {
      await ctx.reply('⚠️ Invalid Telegram ID or cannot remove yourself.');
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
}

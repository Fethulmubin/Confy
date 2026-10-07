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
      const existing = await db.getUser(targetId);
      const name = existing?.name || `Staff Member`;
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
          `📱 *Username:* ${escapeMarkdown(saved.username ? '@' + saved.username : 'None')}\n` +
          `🆔 *Telegram ID:* \`${saved.telegram_id}\`\n` +
          `🔑 *Role Assigned:* *${saved.role.toUpperCase()}*\n` +
          `Approved by Manager ${manager.name} at ${formatTime(new Date())}`,
          { parse_mode: 'Markdown' }
        );
      } catch {}

      // Notify the approved employee directly
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
  bot.action(/^team_view_user_(-?\d+)$/, async (ctx) => {
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
      const idDisplay =
        targetUser.telegram_id > 0
          ? `\`${targetUser.telegram_id}\``
          : `_Pending_ (will link on /start)`;
      const text =
        `👤 *Staff Member Details*\n\n` +
        `• *Name:* ${escapeMarkdown(targetUser.name)}\n` +
        `• *Username:* ${escapeMarkdown(usernameStr)}\n` +
        `• *Telegram ID:* ${idDisplay}\n` +
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
  bot.action(/^team_prompt_role_(-?\d+)$/, async (ctx) => {
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
  bot.action(/^team_assign_(-?\d+)_([a-z]+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    const newRole = ctx.match[2] as UserRole;

    try {
      const existing = await db.getUser(targetId);
      const name = existing?.name || `Staff Member`;
      const username = existing?.username || null;

      const updated = await db.upsertUser({
        telegram_id: targetId,
        name,
        role: newRole,
        username,
      });

      await ctx.answerCbQuery(`Role updated to ${newRole.toUpperCase()}!`);

      // Notify the user in their private chat if their real Telegram ID is known
      if (targetId > 0) {
        try {
          await bot.telegram.sendMessage(
            targetId,
            `ℹ️ *Role Updated*\n\n` +
            `Manager *${manager.name}* updated your system role to: *${newRole.toUpperCase()}*.\n` +
            `Send /start to refresh your menu.`,
            { parse_mode: 'Markdown' }
          );
        } catch {}
      }

      // Return to user view
      const usernameStr = updated.username ? `@${updated.username}` : 'None';
      const idDisplay =
        updated.telegram_id > 0
          ? `\`${updated.telegram_id}\``
          : `_Pending_ (links automatically when user runs /start)`;

      await ctx.editMessageText(
        `✅ *Staff Member Added / Role Updated!*\n\n` +
        `• *Name:* ${escapeMarkdown(updated.name)}\n` +
        `• *Username:* ${escapeMarkdown(usernameStr)}\n` +
        `• *Telegram ID:* ${idDisplay}\n` +
        `• *Assigned Role:* *${updated.role.toUpperCase()}*\n\n` +
        `Updated by ${manager.name} at ${formatTime(new Date())}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Back to Staff List', 'team_list_all')],
            [Markup.button.callback('👥 Team Dashboard', 'team_dashboard')],
          ]),
        }
      );
    } catch (err: any) {
      console.error('[Manager] Error assigning role:', err);
      await ctx.answerCbQuery('Database error updating role.', { show_alert: true });
    }
  });

  // Callback: Confirm removal
  bot.action(/^team_confirm_remove_(-?\d+)$/, async (ctx) => {
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
  bot.action(/^team_do_remove_(-?\d+)$/, async (ctx) => {
    const manager = await checkCallbackRole(ctx, ['manager']);
    if (!manager) return;

    const targetId = parseInt(ctx.match[1], 10);
    try {
      await db.deleteUser(targetId);
      await ctx.answerCbQuery('User removed.');

      await ctx.editMessageText(
        `✅ *User Removed*\n\n` +
        `Access for user with ID \`${targetId}\` has been revoked.`,
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

    const promptText =
      `➕ <b>Add New Staff Member</b>\n\n` +
      `Please reply with the employee's:\n` +
      `• <b>Telegram Username</b> (e.g. <code>@dawit_t</code>)\n` +
      `• OR <b>Numeric Telegram ID</b> (e.g. <code>987654321</code>)\n` +
      `• OR both (e.g. <code>@dawit_t 987654321</code>)\n\n` +
      `<i>(Optional: include their name, e.g. <code>@dawit_t Dawit Tadesse</code>)</i>\n\n` +
      `Or use command: <code>/add_user @username &lt;role&gt; [name]</code>`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Cancel', 'team_dashboard')],
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
        await ctx.reply('🔄 Add user cancelled.');
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
        `⚠️ Could not recognize a valid Telegram username or ID from: <code>${escapeMarkdown(text)}</code>\n\n` +
        `Please send:\n` +
        `• A username (e.g. <code>@dawit_t</code>)\n` +
        `• An ID (e.g. <code>987654321</code>)\n\n` +
        `<i>(Type /cancel to abort)</i>`,
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
        : `_Pending_ (will link automatically on /start)`;

    const promptText =
      `👤 *Staff Member Identified!*\n\n` +
      `• *Name:* ${escapeMarkdown(resolved.name)}\n` +
      `• *Username:* ${escapeMarkdown(resolved.username ? '@' + resolved.username : 'None')}\n` +
      `• *Telegram ID:* ${idDisplay}\n\n` +
      `👇 *Select their role to activate their account:*`;

    const buttons = [
      [
        Markup.button.callback('💼 Sales Rep', `team_assign_${resolved.id}_sales`),
        Markup.button.callback('📦 Store Staff', `team_assign_${resolved.id}_store`),
      ],
      [
        Markup.button.callback('💳 Finance Analyst', `team_assign_${resolved.id}_finance`),
        Markup.button.callback('👔 Manager', `team_assign_${resolved.id}_manager`),
      ],
      [Markup.button.callback('⬅️ Cancel', 'team_dashboard')],
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
      await ctx.reply('⛔ Only Managers can add users.');
      return;
    }

    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);

    if (parts.length < 3) {
      await ctx.reply(
        `ℹ️ <b>Usage:</b> <code>/add_user &lt;@username_or_id&gt; &lt;role&gt; [name]</code>\n\n` +
        `<b>Roles:</b> <code>sales</code>, <code>store</code>, <code>finance</code>, <code>manager</code>\n\n` +
        `<b>Examples:</b>\n` +
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
      await ctx.reply(`⚠️ Invalid role '${roleArg}'. Allowed: ${validRoles.join(', ')}`);
      return;
    }

    const resolved = await resolveUserIdentity(bot, `${identifier} ${customName || ''}`);
    if (!resolved) {
      await ctx.reply(
        `⚠️ Could not recognize username or Telegram ID for \`${identifier}\`.\n` +
        `Please provide their username (@username) or numeric Telegram ID.`
      );
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
          : `_Pending_ (will link automatically on /start)`;

      await ctx.reply(
        `✅ *Staff Member Added & Activated!*\n\n` +
        `👤 *Name:* ${escapeMarkdown(saved.name)}\n` +
        `📱 *Username:* ${escapeMarkdown(saved.username ? '@' + saved.username : 'None')}\n` +
        `🆔 *Telegram ID:* ${idDisplay}\n` +
        `🔑 *Role:* *${saved.role.toUpperCase()}*\n\n` +
        `They can now message the bot directly with /start to begin.`,
        { parse_mode: 'Markdown' }
      );

      if (saved.telegram_id > 0) {
        try {
          await bot.telegram.sendMessage(
            saved.telegram_id,
            `🎉 *Welcome!*\n\nYou have been registered as *${roleArg.toUpperCase()}* by Manager ${user.name}.\nSend /start to open your dashboard.`,
            { parse_mode: 'Markdown' }
          );
        } catch {}
      }
    } catch (err: any) {
      console.error('[Manager] Error adding user:', err);
      await ctx.reply(`⚠️ Failed to save user: ${err.message}`);
    }
  });

  // Direct slash command: /remove_user <id_or_username>
  bot.command('remove_user', async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user || user.role !== 'manager') {
      await ctx.reply('⛔ Only Managers can remove users.');
      return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('ℹ️ Usage: `/remove_user <telegram_id_or_username>`', { parse_mode: 'Markdown' });
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
      await ctx.reply('⚠️ Invalid Telegram ID / Username or cannot remove yourself.');
      return;
    }

    try {
      await db.deleteUser(targetId);
      await ctx.reply(`✅ User \`${identifier}\` removed from the system.`, { parse_mode: 'Markdown' });
    } catch (err: any) {
      console.error('[Manager] Error deleting user:', err);
      await ctx.reply(`⚠️ Failed to remove user: ${err.message}`);
    }
  });
}

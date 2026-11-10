import { Telegraf, Markup } from 'telegraf';
import { db } from '../supabase';
import { checkCallbackRole, authenticateUser } from '../middleware/auth';
import { escapeMarkdown, formatCurrency, formatTime, cleanItemDetailsForSales, extractStoreExpenseHistory } from '../utils';

export function registerFinanceHandlers(bot: Telegraf): void {
  // Callback: Confirm Paid (executable by Finance staff OR Manager)
  bot.action(/^(?:fin|finance)_confirm_(\d+)$/, async (ctx) => {
    const financeUser = await checkCallbackRole(ctx, ['finance']);
    if (!financeUser) return; // Alert sent inside checkCallbackRole

    const orderId = parseInt(ctx.match[1], 10);

    try {
      const order = await db.getOrder(orderId);
      if (!order) {
        await ctx.answerCbQuery(`Order #${orderId} አልተገኘም።`, { show_alert: true });
        return;
      }

      if (order.status !== 'pending_audit') {
        await ctx.answerCbQuery(
          `Order #${orderId} በአሁን ሰዓት '${order.status}' ላይ ስለሆነ ማጽደቅ አይቻልም።`,
          { show_alert: true }
        );
        return;
      }

      // 1. Update status to 'completed'
      const updatedOrder = await db.updateOrderStatus(orderId, 'completed');

      // 2. Fetch sales rep info
      const salesRep = await db.getUser(updatedOrder.sales_id);
      const repName = salesRep?.name || `Rep ID ${updatedOrder.sales_id}`;
      const timeStr = formatTime(new Date());

      const isManager = financeUser.roles.includes('manager') || financeUser.role === 'manager';
      const roleTitle = isManager ? 'Manager' : 'Finance Analyst';

      const expenseHistory = extractStoreExpenseHistory(updatedOrder.item_details);
      const expenseLine = expenseHistory ? `\n> 🚚 *የ Store ጭነት/ጉልበት ወጪ:* \`${escapeMarkdown(expenseHistory)}\`` : '';

      // 3. Edit message caption in-place to remove actionable buttons
      const updatedCaption =
        `💳 *Payment Audit: Order #${updatedOrder.id}*\n\n` +
        `> 👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
        `> 💼 *Sales Rep:* ${escapeMarkdown(repName)}\n` +
        `> 💰 *የተከፈለ መጠን (Amount Settled):* *${formatCurrency(updatedOrder.total_amount)}*\n` +
        `> 📦 *Items:* ${escapeMarkdown(cleanItemDetailsForSales(updatedOrder.item_details))}` +
        expenseLine +
        `\n\n✅ *በ ${roleTitle} (${financeUser.name}) ተረጋግጦ ተጠናቋል (Verified)* በ ${timeStr}`;

      try {
        await ctx.editMessageCaption(updatedCaption, {
          parse_mode: 'Markdown',
        });
      } catch (editErr: any) {
        try {
          await ctx.editMessageText(updatedCaption, { parse_mode: 'Markdown' });
        } catch {
          console.warn('[Finance] Could not edit message:', editErr.message);
        }
      }

      await ctx.answerCbQuery(`Order #${orderId} ክፍያ በ ${roleTitle} ተረጋግጦ ተጠናቋል!`);

      // 4. Send confirmation notification to the sales rep's 1-on-1 private chat
      try {
        await bot.telegram.sendMessage(
          updatedOrder.sales_id,
          `🎉 *Order #${updatedOrder.id} ሙሉ በሙሉ ተጠናቋል!*\n\n` +
          `> 👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
          `> 💰 *የተከፈለ መጠን:* *${formatCurrency(updatedOrder.total_amount)}*\n` +
          `> 🛡️ *Audit ያደረገው:* ${roleTitle} (${financeUser.name})\n` +
          `> 🏁 *Status:* COMPLETED\n\n` +
          `✨ _የተላከው Payment Slip ተረጋግጧል። ይህ Order በስኬት ተጠናቋል!_`,
          { parse_mode: 'Markdown' }
        );
      } catch (notifyErr: any) {
        console.warn(
          `[Finance] Failed to notify sales rep ${updatedOrder.sales_id}:`,
          notifyErr.message
        );
      }
    } catch (err: any) {
      console.error(`[Finance] Error confirming order #${orderId}:`, err);
      await ctx.answerCbQuery('ክፍያውን በማረጋገጥ ሂደት ላይ የ database ስህተት አጋጥሟል።', {
        show_alert: true,
      });
    }
  });

  // Callback: Flag Discrepancy / Flag Issue (executable by Finance staff OR Manager)
  bot.action(/^(?:fin|finance)_flag_(\d+)$/, async (ctx) => {
    const financeUser = await checkCallbackRole(ctx, ['finance']);
    if (!financeUser) return; // Alert sent inside checkCallbackRole

    const orderId = parseInt(ctx.match[1], 10);

    try {
      const order = await db.getOrder(orderId);
      if (!order) {
        await ctx.answerCbQuery(`Order #${orderId} አልተገኘም።`, { show_alert: true });
        return;
      }

      if (order.status !== 'pending_audit') {
        await ctx.answerCbQuery(
          `Order #${orderId} በአሁን ሰዓት '${order.status}' ላይ ነው።`,
          { show_alert: true }
        );
        return;
      }

      // 1. Revert order status to 'dispatched' so the rep can upload the correct slip
      const updatedOrder = await db.updateOrderStatus(orderId, 'dispatched');

      // 2. Fetch sales rep info
      const salesRep = await db.getUser(updatedOrder.sales_id);
      const repName = salesRep?.name || `Rep ID ${updatedOrder.sales_id}`;
      const timeStr = formatTime(new Date());

      const isManager = financeUser.roles.includes('manager') || financeUser.role === 'manager';
      const roleTitle = isManager ? 'Manager' : 'Finance Analyst';

      const expenseHistory = extractStoreExpenseHistory(updatedOrder.item_details);
      const expenseLine = expenseHistory ? `\n> 🚚 *የ Store ጭነት/ጉልበት ወጪ:* \`${escapeMarkdown(expenseHistory)}\`` : '';

      // 3. Edit message caption in-place
      const updatedCaption =
        `💳 *Payment Audit: Order #${updatedOrder.id}*\n\n` +
        `> 👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
        `> 💼 *Sales Rep:* ${escapeMarkdown(repName)}\n` +
        `> 💰 *የሚጠበቀው ጠቅላላ ዋጋ:* *${formatCurrency(updatedOrder.total_amount)}*` +
        expenseLine +
        `\n\n⚠️ *በ ${roleTitle} (${financeUser.name}) Flag ተደርጓል* በ ${timeStr}\n` +
        `_በተላከው Payment Slip ላይ ችግር ተገኝቷል። ለ Sales Rep እንዲስተካከል ተመልሷል።_`;

      try {
        await ctx.editMessageCaption(updatedCaption, {
          parse_mode: 'Markdown',
        });
      } catch (editErr: any) {
        try {
          await ctx.editMessageText(updatedCaption, { parse_mode: 'Markdown' });
        } catch {
          console.warn('[Finance] Could not edit message:', editErr.message);
        }
      }

      await ctx.answerCbQuery(`Order #${orderId} Flag ተደርጓል። ለ Sales Rep ማሳወቂያ ተልኳል።`);

      // 4. Notify sales rep in direct 1-on-1 chat
      try {
        await bot.telegram.sendMessage(
          updatedOrder.sales_id,
          `⚠️ *በ Payment Slip ላይ ችግር ተገኝቷል (Discrepancy)*\n\n` +
          `> 🆔 *Order:* #${updatedOrder.id}\n` +
          `> 👤 *Reviewer:* ${roleTitle} (${financeUser.name})\n` +
          `> 💰 *የሚጠበቀው መጠን:* *${formatCurrency(updatedOrder.total_amount)}*\n\n` +
          `በተላከው የባንክ Payment Slip ላይ ችግር ተገኝቷል። እባክዎ የከፈሉበትን ትክክለኛ የባንክ ደረሰኝ ከታች በድጋሚ ይላኩ:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `💳 የ #${updatedOrder.id} Payment Slip በድጋሚ ላክ`,
                    callback_data: `start_slip_${updatedOrder.id}`,
                  },
                ],
              ],
            },
          }
        );
      } catch (notifyErr: any) {
        console.warn(
          `[Finance] Failed to notify sales rep ${updatedOrder.sales_id}:`,
          notifyErr.message
        );
      }
    } catch (err: any) {
      console.error(`[Finance] Error flagging order #${orderId}:`, err);
      await ctx.answerCbQuery('Flag በማድረግ ሂደት ላይ የ database ስህተት አጋጥሟል።', {
        show_alert: true,
      });
    }
  });

  // Helper to display pending payments list
  async function showPendingAudits(ctx: any) {
    const user = await authenticateUser(ctx);
    if (!user) return;

    const isManager = user.roles.includes('manager') || user.role === 'manager';
    const isFinance = user.roles.includes('finance') || user.activeRole === 'finance';

    if (!isManager && !isFinance) {
      await ctx.reply('⛔ Pending ክፍያዎችን Audit ማድረግ የሚችሉት Finance ወይም Manager ብቻ ናቸው።');
      return;
    }

    try {
      const pendingOrders = await db.getOrdersByStatus('pending_audit', 10);

      if (pendingOrders.length === 0) {
        await ctx.reply('✅ *ምንም Pending ክፍያ የለም*\n\nሁሉም የተላኩ Payment Slip-ኦች ተረጋግጠው ተጠናቀዋል።', {
          parse_mode: 'Markdown',
        });
        return;
      }

      await ctx.reply(
        `💳 *Pending Payment Audits (${pendingOrders.length})*\nማረጋገጫ የሚጠብቁ የባንክ Payment Slip-ኦች ዝርዝር:`,
        { parse_mode: 'Markdown' }
      );

      for (const order of pendingOrders) {
        const salesRep = await db.getUser(order.sales_id);
        const repName = salesRep?.name || `Rep ID ${order.sales_id}`;
        const storeExpense = extractStoreExpenseHistory(order.item_details);
        const expenseLine = storeExpense
          ? `\n> 🚚 *የ Store ጭነት/ጉልበት ወጪ:* \`${escapeMarkdown(storeExpense)}\``
          : '';

        const caption =
          `💳 *Payment Audit: Order #${order.id}*\n\n` +
          `> 👤 *Client:* ${escapeMarkdown(order.client_name)}\n` +
          `> 💼 *Sales Rep:* ${escapeMarkdown(repName)}\n` +
          `> 📦 *Items:* ${escapeMarkdown(cleanItemDetailsForSales(order.item_details))}` +
          expenseLine +
          `\n> 💰 *የሚጠበቀው ጠቅላላ ዋጋ:* *${formatCurrency(order.total_amount)}*\n\n` +
          `👇 *የባንክ ማረጋገጫውን (Slip) አይተው ይወስኑ:*`;

        const keyboard = [
          [
            Markup.button.callback('✅ Confirm Paid', `finance_confirm_${order.id}`),
            Markup.button.callback('⚠️ Flag Issue', `finance_flag_${order.id}`),
          ],
        ];

        if (order.payment_slip_file_id) {
          try {
            await ctx.replyWithPhoto(order.payment_slip_file_id, {
              caption,
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard(keyboard),
            });
          } catch {
            await ctx.reply(caption, {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard(keyboard),
            });
          }
        } else {
          await ctx.reply(caption, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(keyboard),
          });
        }
      }
    } catch (err: any) {
      console.error('[Finance] Error listing pending audits:', err);
      await ctx.reply('⚠️ መረጃዎችን ከ database በማምጣት ላይ ስህተት አጋጥሟል።');
    }
  }

  // Action: list pending audit from dashboard button
  bot.action('list_pending_audit', async (ctx) => {
    await ctx.answerCbQuery();
    await showPendingAudits(ctx);
  });

  // Commands: /pending_payments, /audit, /payments
  bot.command(['pending_payments', 'audit', 'payments'], async (ctx) => {
    await showPendingAudits(ctx);
  });

  // Command: /confirm_paid <order_id>
  bot.command('confirm_paid', async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user) return;

    const isManager = user.roles.includes('manager') || user.role === 'manager';
    const isFinance = user.roles.includes('finance') || user.activeRole === 'finance';
    if (!isManager && !isFinance) {
      await ctx.reply('⛔ ክፍያ ማረጋገጥ የሚችሉት Finance ወይም Manager ብቻ ናቸው።');
      return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('ℹ️ አጠቃቀም: `/confirm_paid <order_id>`', { parse_mode: 'Markdown' });
      return;
    }

    const orderId = parseInt(parts[1].replace('#', ''), 10);
    if (isNaN(orderId)) {
      await ctx.reply('⚠️ ትክክለኛ ያልሆነ Order ID ነው።');
      return;
    }

    const order = await db.getOrder(orderId);
    if (!order) {
      await ctx.reply(`Order #${orderId} አልተገኘም።`);
      return;
    }

    if (order.status !== 'pending_audit') {
      await ctx.reply(`Order #${orderId} በአሁን ሰዓት '${order.status}' ላይ ስለሆነ ማረጋገጥ አይቻልም።`);
      return;
    }

    const updated = await db.updateOrderStatus(orderId, 'completed');
    const roleTitle = isManager ? 'Manager' : 'Finance Analyst';

    await ctx.reply(`✅ *Order #${orderId} ተረጋግጧል!*\nክፍያው በ ${roleTitle} (${user.name}) ተረጋግጧል።`, {
      parse_mode: 'Markdown',
    });

    try {
      await bot.telegram.sendMessage(
        updated.sales_id,
        `🎉 *Order #${updated.id} ተረጋግጧል!*\n\n` +
        `*${roleTitle}* (*${user.name}*) ለ *${escapeMarkdown(updated.client_name)}* የተላከውን ክፍያ አረጋግጠዋል።\n` +
        `ጠቅላላ: *${formatCurrency(updated.total_amount)}*\n` +
        `Status: *COMPLETED*.`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
  });

  // Command: /flag_payment <order_id>
  bot.command('flag_payment', async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user) return;

    const isManager = user.roles.includes('manager') || user.role === 'manager';
    const isFinance = user.roles.includes('finance') || user.activeRole === 'finance';
    if (!isManager && !isFinance) {
      await ctx.reply('⛔ ክፍያ Flag ማድረግ የሚችሉት Finance ወይም Manager ብቻ ናቸው።');
      return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('ℹ️ አጠቃቀም: `/flag_payment <order_id>`', { parse_mode: 'Markdown' });
      return;
    }

    const orderId = parseInt(parts[1].replace('#', ''), 10);
    if (isNaN(orderId)) {
      await ctx.reply('⚠️ ትክክለኛ ያልሆነ Order ID ነው።');
      return;
    }

    const order = await db.getOrder(orderId);
    if (!order) {
      await ctx.reply(`Order #${orderId} አልተገኘም።`);
      return;
    }

    if (order.status !== 'pending_audit') {
      await ctx.reply(`Order #${orderId} በአሁን ሰዓት '${order.status}' ላይ ነው።`);
      return;
    }

    const updated = await db.updateOrderStatus(orderId, 'dispatched');
    const roleTitle = isManager ? 'Manager' : 'Finance Analyst';

    await ctx.reply(`⚠️ *Order #${orderId} Flag ተደርጓል።*\nSales rep ደረሰኝ በድጋሚ እንዲልክ ተጠይቋል።`, {
      parse_mode: 'Markdown',
    });

    try {
      await bot.telegram.sendMessage(
        updated.sales_id,
        `⚠️ *በ Payment Slip ላይ ችግር ተገኝቷል*\n\n` +
        `*${roleTitle}* (*${user.name}*) የ Order #${updated.id} ክፍያን አይተው ችግር (discrepancy) እንዳለ ጠቁመዋል።\n\n` +
        `እባክዎ የባንክ ክፍያውን አረጋግጠው ትክክለኛውን የ Payment Slip ከታች በድጋሚ ይላኩ:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: `💳 የ #${updated.id} Payment Slip በድጋሚ ላክ`,
                  callback_data: `start_slip_${updated.id}`,
                },
              ],
            ],
          },
        }
      );
    } catch {}
  });

  // Handle keyboard button text: '💳 Pending Payments'
  bot.hears('💳 Pending Payments', async (ctx) => {
    await showPendingAudits(ctx);
  });
}

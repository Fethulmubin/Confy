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
        await ctx.answerCbQuery(`Order #${orderId} not found.`, { show_alert: true });
        return;
      }

      if (order.status !== 'pending_audit') {
        await ctx.answerCbQuery(
          `Order #${orderId} is currently '${order.status}'. Cannot confirm.`,
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
      const expenseLine = expenseHistory ? `\n> 🚚 *Store Dispatch Cost:* \`${escapeMarkdown(expenseHistory)}\`` : '';

      // 3. Edit message caption in-place to remove actionable buttons
      const updatedCaption =
        `💳 *Payment Audit: Order #${updatedOrder.id}*\n\n` +
        `> 👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
        `> 💼 *Sales Rep:* ${escapeMarkdown(repName)}\n` +
        `> 💰 *Amount Settled:* *${formatCurrency(updatedOrder.total_amount)}*\n` +
        `> 📦 *Items:* ${escapeMarkdown(cleanItemDetailsForSales(updatedOrder.item_details))}` +
        expenseLine +
        `\n\n✅ *Verified & Settled by ${roleTitle}* (${financeUser.name}) at ${timeStr}`;

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

      await ctx.answerCbQuery(`Order #${orderId} payment verified & settled by ${roleTitle}!`);

      // 4. Send confirmation notification to the sales rep's 1-on-1 private chat
      try {
        await bot.telegram.sendMessage(
          updatedOrder.sales_id,
          `🎉 *Order #${updatedOrder.id} Fully Settled!*\n\n` +
          `> 👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
          `> 💰 *Amount Paid:* *${formatCurrency(updatedOrder.total_amount)}*\n` +
          `> 🛡️ *Audited by:* ${roleTitle} (${financeUser.name})\n` +
          `> 🏁 *Status:* COMPLETED\n\n` +
          `✨ _Payment has been verified. This order is officially completed!_`,
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
      await ctx.answerCbQuery('Database error during payment confirmation.', {
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
        await ctx.answerCbQuery(`Order #${orderId} not found.`, { show_alert: true });
        return;
      }

      if (order.status !== 'pending_audit') {
        await ctx.answerCbQuery(
          `Order #${orderId} is currently '${order.status}'.`,
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
      const expenseLine = expenseHistory ? `\n> 🚚 *Store Dispatch Cost:* \`${escapeMarkdown(expenseHistory)}\`` : '';

      // 3. Edit message caption in-place
      const updatedCaption =
        `💳 *Payment Audit: Order #${updatedOrder.id}*\n\n` +
        `> 👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
        `> 💼 *Sales Rep:* ${escapeMarkdown(repName)}\n` +
        `> 💰 *Expected Amount:* *${formatCurrency(updatedOrder.total_amount)}*` +
        expenseLine +
        `\n\n⚠️ *Flagged by ${roleTitle}* (${financeUser.name}) at ${timeStr}\n` +
        `_Discrepancy reported. Returned to sales rep for correction._`;

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

      await ctx.answerCbQuery(`Order #${orderId} flagged. Sales rep notified.`);

      // 4. Notify sales rep in direct 1-on-1 chat
      try {
        await bot.telegram.sendMessage(
          updatedOrder.sales_id,
          `⚠️ *Payment Slip Issue Flagged*\n\n` +
          `> 🆔 *Order:* #${updatedOrder.id}\n` +
          `> 👤 *Reviewer:* ${roleTitle} (${financeUser.name})\n` +
          `> 💰 *Expected Amount:* *${formatCurrency(updatedOrder.total_amount)}*\n\n` +
          `A discrepancy was found with the submitted bank transfer slip. Please check your transaction record and re-upload the correct payment slip below:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `💳 Re-upload Payment Slip for #${updatedOrder.id}`,
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
      await ctx.answerCbQuery('Database error during payment flag.', {
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
      await ctx.reply('⛔ Only Finance staff and Managers can audit pending payments.');
      return;
    }

    try {
      const pendingOrders = await db.getOrdersByStatus('pending_audit', 10);

      if (pendingOrders.length === 0) {
        await ctx.reply('✅ *No Pending Payments*\n\nAll submitted payment slips are verified and settled.', {
          parse_mode: 'Markdown',
        });
        return;
      }

      await ctx.reply(
        `💳 *Pending Payment Audits (${pendingOrders.length})*\nReviewing payment slips awaiting verification:`,
        { parse_mode: 'Markdown' }
      );

      for (const order of pendingOrders) {
        const salesRep = await db.getUser(order.sales_id);
        const repName = salesRep?.name || `Rep ID ${order.sales_id}`;
        const storeExpense = extractStoreExpenseHistory(order.item_details);
        const expenseLine = storeExpense
          ? `\n> 🚚 *Store Dispatch Cost:* \`${escapeMarkdown(storeExpense)}\``
          : '';

        const caption =
          `💳 *Payment Audit: Order #${order.id}*\n\n` +
          `> 👤 *Client:* ${escapeMarkdown(order.client_name)}\n` +
          `> 💼 *Sales Rep:* ${escapeMarkdown(repName)}\n` +
          `> 📦 *Items:* ${escapeMarkdown(cleanItemDetailsForSales(order.item_details))}` +
          expenseLine +
          `\n> 💰 *Total Expected:* *${formatCurrency(order.total_amount)}*\n\n` +
          `👇 *Verify bank transfer slip and choose action:*`;

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
      await ctx.reply('⚠️ Error retrieving pending payments from database.');
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
      await ctx.reply('⛔ Only Finance or Manager can confirm payment.');
      return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('ℹ️ Usage: `/confirm_paid <order_id>`', { parse_mode: 'Markdown' });
      return;
    }

    const orderId = parseInt(parts[1].replace('#', ''), 10);
    if (isNaN(orderId)) {
      await ctx.reply('⚠️ Invalid Order ID.');
      return;
    }

    const order = await db.getOrder(orderId);
    if (!order) {
      await ctx.reply(`Order #${orderId} not found.`);
      return;
    }

    if (order.status !== 'pending_audit') {
      await ctx.reply(`Order #${orderId} is currently '${order.status}'. Cannot confirm payment.`);
      return;
    }

    const updated = await db.updateOrderStatus(orderId, 'completed');
    const roleTitle = isManager ? 'Manager' : 'Finance Analyst';

    await ctx.reply(`✅ *Order #${orderId} Settled!*\nPayment confirmed by ${roleTitle} (${user.name}).`, {
      parse_mode: 'Markdown',
    });

    try {
      await bot.telegram.sendMessage(
        updated.sales_id,
        `🎉 *Order #${updated.id} Settled!*\n\n` +
        `*${roleTitle}* (*${user.name}*) has verified and confirmed the payment for *${escapeMarkdown(updated.client_name)}*.\n` +
        `Total: *${formatCurrency(updated.total_amount)}*\n` +
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
      await ctx.reply('⛔ Only Finance or Manager can flag payment.');
      return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('ℹ️ Usage: `/flag_payment <order_id>`', { parse_mode: 'Markdown' });
      return;
    }

    const orderId = parseInt(parts[1].replace('#', ''), 10);
    if (isNaN(orderId)) {
      await ctx.reply('⚠️ Invalid Order ID.');
      return;
    }

    const order = await db.getOrder(orderId);
    if (!order) {
      await ctx.reply(`Order #${orderId} not found.`);
      return;
    }

    if (order.status !== 'pending_audit') {
      await ctx.reply(`Order #${orderId} is currently '${order.status}'.`);
      return;
    }

    const updated = await db.updateOrderStatus(orderId, 'dispatched');
    const roleTitle = isManager ? 'Manager' : 'Finance Analyst';

    await ctx.reply(`⚠️ *Order #${orderId} Flagged.*\nSales rep requested to re-upload payment slip.`, {
      parse_mode: 'Markdown',
    });

    try {
      await bot.telegram.sendMessage(
        updated.sales_id,
        `⚠️ *Payment Slip Issue Flagged*\n\n` +
        `*${roleTitle}* (*${user.name}*) reviewed your payment slip for Order #${updated.id} and flagged a discrepancy.\n\n` +
        `Please check the bank transaction and re-upload the correct payment slip below:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: `💳 Re-upload Payment Slip for #${updated.id}`,
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

import { Telegraf } from 'telegraf';
import { db } from '../supabase';
import { checkCallbackRole } from '../middleware/auth';
import { escapeMarkdown, formatCurrency, formatTime } from '../utils';

export function registerFinanceHandlers(bot: Telegraf): void {
  // Callback: Confirm Paid
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

      // 3. Edit message caption in-place to remove actionable buttons
      const updatedCaption =
        `Payment Audit: Order #${updatedOrder.id}\n` +
        `Sales Rep: ${escapeMarkdown(repName)} | Expected: ${formatCurrency(updatedOrder.total_amount)}\n` +
        `Client: ${escapeMarkdown(updatedOrder.client_name)}\n` +
        `Items: ${escapeMarkdown(updatedOrder.item_details)}\n\n` +
        `✅ *Verified & Settled by Finance* (${financeUser.name}) at ${timeStr}`;

      try {
        await ctx.editMessageCaption(updatedCaption, {
          parse_mode: 'Markdown',
        });
      } catch (editErr: any) {
        console.warn('[Finance] Could not edit caption:', editErr.message);
      }

      await ctx.answerCbQuery(`Order #${orderId} payment verified & settled!`);

      // 4. Send confirmation notification to the sales rep's 1-on-1 private chat
      try {
        await bot.telegram.sendMessage(
          updatedOrder.sales_id,
          `🎉 *Order #${updatedOrder.id} Settled!*\n\n` +
          `Finance (*${financeUser.name}*) has verified and confirmed the payment for *${escapeMarkdown(updatedOrder.client_name)}*.\n` +
          `Total: *${formatCurrency(updatedOrder.total_amount)}*\n` +
          `Status: *COMPLETED*.`,
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

  // Callback: Flag Discrepancy / Flag Issue
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

      // 3. Edit message caption in-place
      const updatedCaption =
        `Payment Audit: Order #${updatedOrder.id}\n` +
        `Sales Rep: ${escapeMarkdown(repName)} | Expected: ${formatCurrency(updatedOrder.total_amount)}\n` +
        `Client: ${escapeMarkdown(updatedOrder.client_name)}\n` +
        `Items: ${escapeMarkdown(updatedOrder.item_details)}\n\n` +
        `⚠️ *Flagged by Finance* (${financeUser.name}) at ${timeStr}\n` +
        `Discrepancy reported. Returned to sales rep for correction.`;

      try {
        await ctx.editMessageCaption(updatedCaption, {
          parse_mode: 'Markdown',
        });
      } catch (editErr: any) {
        console.warn('[Finance] Could not edit caption:', editErr.message);
      }

      await ctx.answerCbQuery(`Order #${orderId} flagged. Sales rep notified.`);

      // 4. Notify sales rep in direct 1-on-1 chat
      try {
        await bot.telegram.sendMessage(
          updatedOrder.sales_id,
          `⚠️ *Payment Slip Issue Flagged*\n\n` +
          `Finance (*${financeUser.name}*) reviewed your payment slip for Order #${updatedOrder.id} and flagged a discrepancy.\n\n` +
          `Please check the bank transaction and re-upload the correct payment slip below:`,
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
}

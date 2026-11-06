import { Telegraf } from 'telegraf';
import { db } from '../supabase';
import { escapeMarkdown, formatCurrency } from '../utils';

export function registerStoreHandlers(bot: Telegraf): void {
  // Store receipt photo upload handler in group/topic
  bot.on('photo', async (ctx, next) => {
    // Only handle group/supergroup photo messages for store fulfillment
    if (ctx.chat.type === 'private') {
      return next(); // Pass to sales handler
    }

    const message = ctx.message;
    const replyMsg = message.reply_to_message;

    // Check if replying to an "Order #X — Approved for Release" message
    let orderId: number | null = null;

    if (replyMsg && ('text' in replyMsg || 'caption' in replyMsg)) {
      const sourceText = ('text' in replyMsg ? replyMsg.text : replyMsg.caption) || '';
      const match = sourceText.match(/Order #(\d+)/i);
      if (match) {
        orderId = parseInt(match[1], 10);
      }
    }

    // Fallback: check photo caption for Order #ID
    if (!orderId && message.caption) {
      const match = message.caption.match(/(?:Order\s*#?|#)(\d+)/i);
      if (match) {
        orderId = parseInt(match[1], 10);
      }
    }

    // If this photo is not related to store fulfillment, pass to next middleware
    if (!orderId) {
      return next();
    }

    const telegramId = ctx.from.id;

    try {
      // 1. Role verification: must have 'store' or 'manager' role
      const user = await db.getUser(telegramId);
      const isAuthorized =
        user &&
        (user.roles.includes('store') ||
          user.roles.includes('manager') ||
          user.role === 'store' ||
          user.role === 'manager');

      if (!isAuthorized) {
        await ctx.reply(
          `🚫 Access denied: Telegram ID ${telegramId} is not authorized for Store fulfillment actions.`,
          { reply_parameters: { message_id: message.message_id } }
        );
        return;
      }

      // 2. Fetch and validate order status
      const order = await db.getOrder(orderId);
      if (!order) {
        await ctx.reply(`Order #${orderId} not found in database.`, {
          reply_parameters: { message_id: message.message_id },
        });
        return;
      }

      if (order.status !== 'pending_dispatch') {
        await ctx.reply(
          `⚠️ Order #${orderId} cannot be dispatched because its status is '${order.status}'.`,
          { reply_parameters: { message_id: message.message_id } }
        );
        return;
      }

      // 3. Capture native Telegram file_id and optional delivery/labour expenses from caption
      const photo = message.photo[message.photo.length - 1];
      const receiptFileId = photo.file_id;
      const captionText = message.caption || '';

      // Check if store staff provided delivery / truck / labour expenses in caption
      // e.g., "Truck: 300, Labour: 150" or "+450 delivery" or "transport 500"
      let extraExpense: { amount: number; note: string } | undefined = undefined;
      const expenseMatches = captionText.matchAll(/(?:truck|labour|labor|transport|delivery|fee|exp|extra|\+)\s*[:=-]?\s*(\d+(?:\.\d+)?)/gi);
      let totalExtra = 0;
      const notes: string[] = [];

      for (const m of expenseMatches) {
        const val = parseFloat(m[1]);
        if (!isNaN(val) && val > 0) {
          totalExtra += val;
          notes.push(m[0].trim());
        }
      }

      if (totalExtra > 0) {
        extraExpense = {
          amount: totalExtra,
          note: notes.join(', ') || `Delivery & Labour (${totalExtra} ETB)`,
        };
      }

      // 4. Update order in Supabase
      const updatedOrder = await db.setStoreReceipt(orderId, receiptFileId, extraExpense);

      // 5. Reply in store topic acknowledging fulfillment
      const expenseNotice = extraExpense
        ? `\n🚚 *Dispatch Expenses Added:* ${formatCurrency(extraExpense.amount)} (${escapeMarkdown(extraExpense.note)})\n💰 *New Total Amount:* ${formatCurrency(updatedOrder.total_amount)}`
        : '';

      await ctx.reply(
        `✅ *Order #${orderId} Dispatched*\n` +
        `Release receipt saved. Delivery notice forwarded privately to sales representative.${expenseNotice}`,
        {
          parse_mode: 'Markdown',
          reply_parameters: { message_id: message.message_id },
        }
      );

      // 6. ISOLATED DELIVERY: Send receipt photo ONLY to the owning sales rep's 1-on-1 private chat
      try {
        const extraBreakdown = extraExpense
          ? `🚚 *Dispatch Expenses:* +${formatCurrency(extraExpense.amount)} (${escapeMarkdown(extraExpense.note)})\n`
          : '';

        await bot.telegram.sendPhoto(
          updatedOrder.sales_id,
          receiptFileId,
          {
            caption:
              `📦 *Store Release Receipt: Order #${updatedOrder.id}*\n\n` +
              `👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
              `📋 *Items:* ${escapeMarkdown(updatedOrder.item_details)}\n` +
              extraBreakdown +
              `💰 *Total Amount to Collect:* ${formatCurrency(updatedOrder.total_amount)}\n\n` +
              `Status: *DISPATCHED*\n` +
              `The signed store release receipt is attached above.\n\n` +
              `👉 Please upload the bank transfer payment slip to proceed with finance audit.`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `💳 Upload Payment Slip for #${updatedOrder.id}`,
                    callback_data: `start_slip_${updatedOrder.id}`,
                  },
                ],
              ],
            },
          }
        );
      } catch (deliveryErr: any) {
        console.error(
          `[Store] Failed to send receipt photo to sales rep ${updatedOrder.sales_id}:`,
          deliveryErr.message
        );
      }
    } catch (err: any) {
      console.error(`[Store] Error handling receipt photo for order #${orderId}:`, err);
      await ctx.reply(`⚠️ Database error processing store receipt for Order #${orderId}.`, {
        reply_parameters: { message_id: message.message_id },
      });
    }
  });
}

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
      // 1. Role verification: must be 'store' (or 'manager')
      const user = await db.getUser(telegramId);
      if (!user || (user.role !== 'store' && user.role !== 'manager')) {
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

      // 3. Capture native Telegram file_id
      const photo = message.photo[message.photo.length - 1];
      const receiptFileId = photo.file_id;

      // 4. Update order in Supabase
      const updatedOrder = await db.setStoreReceipt(orderId, receiptFileId);

      // 5. Reply in store topic acknowledging fulfillment
      await ctx.reply(
        `✅ *Order #${orderId} Dispatched*\n` +
        `Release receipt saved. Delivery notice forwarded privately to sales representative.`,
        {
          parse_mode: 'Markdown',
          reply_parameters: { message_id: message.message_id },
        }
      );

      // 6. ISOLATED DELIVERY: Send receipt photo ONLY to the owning sales rep's 1-on-1 private chat
      try {
        await bot.telegram.sendPhoto(
          updatedOrder.sales_id,
          receiptFileId,
          {
            caption:
              `📦 *Store Release Receipt: Order #${updatedOrder.id}*\n\n` +
              `👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
              `📋 *Items:* ${escapeMarkdown(updatedOrder.item_details)}\n` +
              `💰 *Total:* ${formatCurrency(updatedOrder.total_amount)}\n\n` +
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

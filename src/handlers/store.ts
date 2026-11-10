import { Telegraf } from 'telegraf';
import { db } from '../supabase';
import { config } from '../config';
import { authenticateUser } from '../middleware/auth';
import { escapeMarkdown, formatCurrency, cleanItemDetailsForSales, extractOrderId } from '../utils';

export function registerStoreHandlers(bot: Telegraf): void {
  // Store receipt photo or document upload handler in group/topic
  bot.on(['photo', 'document'], async (ctx, next) => {
    // Only handle group/supergroup messages for store fulfillment
    if (ctx.chat.type === 'private') {
      return next(); // Pass to sales handler
    }

    const message = ctx.message;
    const replyMsg = message.reply_to_message;

    // 1. Check if replying to an order message
    let orderId: number | null = null;

    if (replyMsg && ('text' in replyMsg || 'caption' in replyMsg)) {
      const sourceText = ('text' in replyMsg ? replyMsg.text : ('caption' in replyMsg ? replyMsg.caption : '')) || '';
      orderId = extractOrderId(sourceText);
    }

    // 2. Fallback: check photo/document caption for Order #ID
    if (!orderId && message.caption) {
      orderId = extractOrderId(message.caption);
    }

    // 3. Fallback: If posted in Store topic without explicit reply or caption, check active pending orders
    const isStoreChat =
      String(ctx.chat.id) === String(config.storeChatId) &&
      (!config.storeThreadId || ctx.message.message_thread_id === config.storeThreadId);

    if (!orderId && isStoreChat) {
      try {
        const pending = await db.getOrdersByStatus('pending_dispatch', 5);
        if (pending.length === 1) {
          orderId = pending[0].id;
        } else if (pending.length > 1) {
          await ctx.reply(
            `⚠️ እባክዎ ደረሰኙ ለየትኛው ኦርደር እንደሆነ ለመለየት የሚመለከተውን የኦርደር መልእክት reply ያድርጉ ወይም በፎቶው caption ላይ 'ኦርደር #ቁጥር' ይጥቀሱ።\n\n` +
            `📦 *ከስቶር እንዲወጡ የተፈቀዱ ኦርደሮች:*\n` +
            pending.map((o) => `• ኦርደር #${o.id} (${escapeMarkdown(o.client_name)})`).join('\n'),
            {
              parse_mode: 'Markdown',
              reply_parameters: { message_id: message.message_id },
            }
          );
          return;
        }
      } catch (e) {
        console.warn('[Store] Error checking pending orders fallback:', e);
      }
    }

    // If this message is not related to store fulfillment, pass to next middleware
    if (!orderId) {
      return next();
    }

    try {
      // 1. Role verification: must have 'store' or 'manager' role
      const user = await authenticateUser(ctx);
      const isAuthorized =
        user &&
        (user.roles.includes('store') ||
          user.roles.includes('manager') ||
          user.role === 'store' ||
          user.role === 'manager');

      if (!isAuthorized) {
        await ctx.reply(
          `🚫 አልተፈቀደም: @${ctx.from.username || ctx.from.id} ለስቶር ስራዎች የተፈቀደለት አይደለም።`,
          { reply_parameters: { message_id: message.message_id } }
        );
        return;
      }

      // 2. Fetch and validate order status
      const order = await db.getOrder(orderId);
      if (!order) {
        await ctx.reply(`ኦርደር #${orderId} በሲስተሙ ውስጥ አልተገኘም።`, {
          reply_parameters: { message_id: message.message_id },
        });
        return;
      }

      if (order.status !== 'pending_dispatch') {
        await ctx.reply(
          `⚠️ የኦርደር #${orderId} ሁኔታ '${order.status}' ስለሆነ ከስቶር ማውጣት አይቻልም።`,
          { reply_parameters: { message_id: message.message_id } }
        );
        return;
      }

      // 3. Capture native Telegram file_id from photo or document
      let receiptFileId: string | null = null;
      if ('photo' in message && message.photo && message.photo.length > 0) {
        receiptFileId = message.photo[message.photo.length - 1].file_id;
      } else if ('document' in message && message.document) {
        receiptFileId = message.document.file_id;
      }

      if (!receiptFileId) {
        await ctx.reply(`⚠️ እባክዎ የደረሰኙን ፎቶ ወይም ሰነድ በትክክል ይላኩ።`, {
          reply_parameters: { message_id: message.message_id },
        });
        return;
      }

      const captionText = message.caption || '';

      // Check if store staff provided delivery / truck / labour expenses in caption
      // e.g., "Truck: 300, Labour: 150" or "+450 delivery" or "ጭነት 300 ጉልበት 150"
      let extraExpense: { amount: number; note: string } | undefined = undefined;
      const expenseMatches = captionText.matchAll(
        /(?:truck|labour|labor|transport|delivery|fee|exp|extra|\+|ጭነት|ጉልበት|የጭነት|የጉልበት|ትራንስፖርት|መጓጓዣ)\s*[:=-]?\s*(\d+(?:\.\d+)?)/gi
      );
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
          note: notes.join(', ') || `ጭነት እና ጉልበት (${totalExtra} ETB)`,
        };
      }

      // 4. Update order in Supabase
      const updatedOrder = await db.setStoreReceipt(orderId, receiptFileId, extraExpense);

      // 5. Reply in store topic acknowledging fulfillment
      const expenseNotice = extraExpense
        ? `\n> 🚚 *የተከፈለ ተጨማሪ ወጪ:* ${formatCurrency(extraExpense.amount)} (${escapeMarkdown(extraExpense.note)})`
        : '';

      await ctx.reply(
        `✅ *ኦርደር #${orderId} ከስቶር ወጥቷል*\n\n` +
        `> 👤 *ደንበኛ:* ${escapeMarkdown(order.client_name)}\n` +
        `> 📦 *ሁኔታ:* ደረሰኝ ተመዝግቧል` +
        expenseNotice +
        `\n\n📨 _የተፈረመበት ደረሰኝ ለሴልስ ሬፕ በግል ተልኳል።_`,
        {
          parse_mode: 'Markdown',
          reply_parameters: { message_id: message.message_id },
        }
      );

      // Notify Manager / Orders topic with history that store staff paid dispatch expenses
      if (extraExpense && config.ordersChatId) {
        try {
          await bot.telegram.sendMessage(
            config.ordersChatId,
            `🚚 *የስቶር ጭነት/ጉልበት ወጪ መዝገብ*\n\n` +
            `> 🆔 *ኦርደር:* #${updatedOrder.id}\n` +
            `> 👤 *ደንበኛ:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
            `> 💵 *በስቶር የተከፈለ:* ${formatCurrency(extraExpense.amount)}\n` +
            `> 📝 *ዝርዝር:* ${escapeMarkdown(extraExpense.note)}`,
            {
              parse_mode: 'Markdown',
              message_thread_id: config.ordersThreadId,
            }
          );
        } catch (mErr: any) {
          console.warn('[Store] Could not notify manager of dispatch expense:', mErr.message);
        }
      }

      // 6. ISOLATED DELIVERY: Send receipt photo ONLY to the owning sales rep's 1-on-1 private chat
      // IMPORTANT: Do NOT send dispatch expenses to sales rep! It is strictly for manager history.
      try {
        const salesItems = cleanItemDetailsForSales(updatedOrder.item_details);

        await bot.telegram.sendPhoto(
          updatedOrder.sales_id,
          receiptFileId,
          {
            caption:
              `📦 *የተፈረመ ደረሰኝ: ኦርደር #${updatedOrder.id}*\n\n` +
              `> 👤 *ደንበኛ:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
              `> 📋 *ዕቃዎች:* ${escapeMarkdown(salesItems)}\n` +
              `> 💰 *የሚሰበሰብ ጠቅላላ ዋጋ:* *${formatCurrency(updatedOrder.total_amount)}*\n` +
              `> 📦 *ሁኔታ:* ከስቶር ወጥቷል\n\n` +
              `📎 *የተፈረመበት ደረሰኝ ከላይ ተያይዟል።*\n\n` +
              `👉 እባክዎ ደንበኛው የከፈለበትን የባንክ ስሊፕ ከታች ይላኩ:`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `💳 ስሊፕ ላክ`,
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
      await ctx.reply(`⚠️ ደረሰኝ በማስቀመጥ ላይ ችግር ተፈጥሯል (ኦርደር #${orderId})።`, {
        reply_parameters: { message_id: message.message_id },
      });
    }
  });

  // Guide store staff if they reply with plain text instead of photo/document
  bot.on('text', async (ctx, next) => {
    if (ctx.chat.type === 'private') return next();

    const message = ctx.message;
    const replyMsg = message.reply_to_message;
    if (!replyMsg) return next();

    const sourceText = ('text' in replyMsg ? replyMsg.text : ('caption' in replyMsg ? replyMsg.caption : '')) || '';
    const orderId = extractOrderId(sourceText);
    if (!orderId) return next();

    // Check if the replied message is a store release notice
    if (
      sourceText.includes('እንዲወጣ ተፈቅዷል') ||
      sourceText.includes('Approved for Release') ||
      sourceText.includes('ስቶር ደረሰኝ') ||
      sourceText.includes('Store Receipt')
    ) {
      await ctx.reply(
        `📸 *የስቶር ደረሰኝ ለመመዝገብ እባክዎ ፎቶ (Photo) ይላኩ*\n\n` +
        `ለኦርደር #${orderId} የተፈረመበትን ደረሰኝ በፎቶ መልክ ይላኩ (ይህን መልእክት reply በማድረግ)።\n` +
        `💡 _ማስታወሻ: የጭነት ወይም የጉልበት ወጪ ካለ በፎቶው caption ላይ ይጥቀሱ (ምሳሌ: \`ጭነት: 300, ጉልበት: 150\`)።_`,
        {
          parse_mode: 'Markdown',
          reply_parameters: { message_id: message.message_id },
        }
      );
      return;
    }

    return next();
  });
}


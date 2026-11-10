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
        await ctx.answerCbQuery(`ኦርደር #${orderId} አልተገኘም።`, { show_alert: true });
        return;
      }

      if (order.status !== 'pending_audit') {
        await ctx.answerCbQuery(
          `ኦርደር #${orderId} በአሁን ሰዓት '${order.status}' ላይ ስለሆነ ማጽደቅ አይቻልም።`,
          { show_alert: true }
        );
        return;
      }

      // 1. Update status to 'completed'
      const updatedOrder = await db.updateOrderStatus(orderId, 'completed');

      // 2. Fetch sales rep info
      const salesRep = await db.getUser(updatedOrder.sales_id);
      const repName = salesRep?.name || `ሬፕ ID ${updatedOrder.sales_id}`;
      const timeStr = formatTime(new Date());

      const isManager = financeUser.roles.includes('manager') || financeUser.role === 'manager';
      const roleTitle = isManager ? 'ማናጀር' : 'ፋይናንስ';

      const expenseHistory = extractStoreExpenseHistory(updatedOrder.item_details);
      const expenseLine = expenseHistory ? `\n> 🚚 *የስቶር ጭነት/ጉልበት ወጪ:* \`${escapeMarkdown(expenseHistory)}\`` : '';

      // 3. Edit message caption in-place to remove actionable buttons
      const updatedCaption =
        `💳 *የክፍያ ማረጋገጫ: ኦርደር #${updatedOrder.id}*\n\n` +
        `> 👤 *ደንበኛ:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
        `> 💼 *ሴልስ ሬፕ:* ${escapeMarkdown(repName)}\n` +
        `> 💰 *የተከፈለ መጠን:* *${formatCurrency(updatedOrder.total_amount)}*\n` +
        `> 📦 *ዕቃዎች:* ${escapeMarkdown(cleanItemDetailsForSales(updatedOrder.item_details))}` +
        expenseLine +
        `\n\n✅ *በ ${roleTitle} (${financeUser.name}) ተረጋግጦ ተጠናቋል* በ ${timeStr}`;

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

      await ctx.answerCbQuery(`ኦርደር #${orderId} ክፍያ በ ${roleTitle} ተረጋግጦ ተጠናቋል!`);

      // 4. Send confirmation notification to the sales rep's 1-on-1 private chat
      try {
        await bot.telegram.sendMessage(
          updatedOrder.sales_id,
          `🎉 *ኦርደር #${updatedOrder.id} ሙሉ በሙሉ ተጠናቋል!*\n\n` +
          `> 👤 *ደንበኛ:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
          `> 💰 *የተከፈለ መጠን:* *${formatCurrency(updatedOrder.total_amount)}*\n` +
          `> 🛡️ *ያረጋገጠው:* ${roleTitle} (${financeUser.name})\n` +
          `> 🏁 *ሁኔታ:* ተጠናቋል\n\n` +
          `✨ _የተላከው ስሊፕ ተረጋግጧል። ይህ ኦርደር በስኬት ተጠናቋል!_`,
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
        await ctx.answerCbQuery(`ኦርደር #${orderId} አልተገኘም።`, { show_alert: true });
        return;
      }

      if (order.status !== 'pending_audit') {
        await ctx.answerCbQuery(
          `ኦርደር #${orderId} በአሁን ሰዓት '${order.status}' ላይ ነው።`,
          { show_alert: true }
        );
        return;
      }

      // 1. Revert order status to 'dispatched' so the rep can upload the correct slip
      const updatedOrder = await db.updateOrderStatus(orderId, 'dispatched');

      // 2. Fetch sales rep info
      const salesRep = await db.getUser(updatedOrder.sales_id);
      const repName = salesRep?.name || `ሬፕ ID ${updatedOrder.sales_id}`;
      const timeStr = formatTime(new Date());

      const isManager = financeUser.roles.includes('manager') || financeUser.role === 'manager';
      const roleTitle = isManager ? 'ማናጀር' : 'ፋይናንስ';

      const expenseHistory = extractStoreExpenseHistory(updatedOrder.item_details);
      const expenseLine = expenseHistory ? `\n> 🚚 *የስቶር ጭነት/ጉልበት ወጪ:* \`${escapeMarkdown(expenseHistory)}\`` : '';

      // 3. Edit message caption in-place
      const updatedCaption =
        `💳 *የክፍያ ማረጋገጫ: ኦርደር #${updatedOrder.id}*\n\n` +
        `> 👤 *ደንበኛ:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
        `> 💼 *ሴልስ ሬፕ:* ${escapeMarkdown(repName)}\n` +
        `> 💰 *የሚጠበቀው ጠቅላላ ዋጋ:* *${formatCurrency(updatedOrder.total_amount)}*` +
        expenseLine +
        `\n\n⚠️ *በ ${roleTitle} (${financeUser.name}) ችግር ሪፖርት ተደርጓል* በ ${timeStr}\n` +
        `_በተላከው ስሊፕ ላይ ችግር ተገኝቷል። ለሴልስ ሬፕ እንዲስተካከል ተመልሷል።_`;

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

      await ctx.answerCbQuery(`ኦርደር #${orderId} ችግር ሪፖርት ተደርጓል። ለሴልስ ሬፕ ማሳወቂያ ተልኳል።`);

      // 4. Notify sales rep in direct 1-on-1 chat
      try {
        await bot.telegram.sendMessage(
          updatedOrder.sales_id,
          `⚠️ *በስሊፕ ላይ ችግር ተገኝቷል*\n\n` +
          `> 🆔 *ኦርደር:* #${updatedOrder.id}\n` +
          `> 👤 *ያየው:* ${roleTitle} (${financeUser.name})\n` +
          `> 💰 *የሚጠበቀው መጠን:* *${formatCurrency(updatedOrder.total_amount)}*\n\n` +
          `በተላከው የባንክ ስሊፕ ላይ ችግር ተገኝቷል። እባክዎ የከፈሉበትን ትክክለኛ የባንክ ደረሰኝ ከታች በድጋሚ ይላኩ:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `💳 ስሊፕ በድጋሚ ላክ`,
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
      await ctx.answerCbQuery('ሪፖርት በማድረግ ሂደት ላይ የ database ስህተት አጋጥሟል።', {
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
      await ctx.reply('⛔ ያልተረጋገጡ ክፍያዎችን ማየት የሚችሉት ፋይናንስ ወይም ማናጀር ብቻ ናቸው።');
      return;
    }

    try {
      const pendingOrders = await db.getOrdersByStatus('pending_audit', 10);

      if (pendingOrders.length === 0) {
        await ctx.reply('✅ *ምንም ያልተረጋገጠ ክፍያ የለም*\n\nሁሉም የተላኩ ስሊፖች ተረጋግጠው ተጠናቀዋል።', {
          parse_mode: 'Markdown',
        });
        return;
      }

      await ctx.reply(
        `💳 *ያልተረጋገጡ ክፍያዎች (${pendingOrders.length})*\nማረጋገጫ የሚጠብቁ የባንክ ስሊፖች ዝርዝር:`,
        { parse_mode: 'Markdown' }
      );

      for (const order of pendingOrders) {
        const salesRep = await db.getUser(order.sales_id);
        const repName = salesRep?.name || `ሬፕ ID ${order.sales_id}`;
        const storeExpense = extractStoreExpenseHistory(order.item_details);
        const expenseLine = storeExpense
          ? `\n> 🚚 *የስቶር ጭነት/ጉልበት ወጪ:* \`${escapeMarkdown(storeExpense)}\``
          : '';

        const caption =
          `💳 *የክፍያ ማረጋገጫ: ኦርደር #${order.id}*\n\n` +
          `> 👤 *ደንበኛ:* ${escapeMarkdown(order.client_name)}\n` +
          `> 💼 *ሴልስ ሬፕ:* ${escapeMarkdown(repName)}\n` +
          `> 📦 *ዕቃዎች:* ${escapeMarkdown(cleanItemDetailsForSales(order.item_details))}` +
          expenseLine +
          `\n> 💰 *የሚጠበቀው ጠቅላላ ዋጋ:* *${formatCurrency(order.total_amount)}*\n\n` +
          `👇 *የባንክ ስሊፑን አይተው ይወስኑ:*`;

        const keyboard = [
          [
            Markup.button.callback('✅ ክፍያ አረጋግጥ', `finance_confirm_${order.id}`),
            Markup.button.callback('⚠️ ችግር ሪፖርት አድርግ', `finance_flag_${order.id}`),
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
      await ctx.reply('⛔ ክፍያ ማረጋገጥ የሚችሉት ፋይናንስ ወይም ማናጀር ብቻ ናቸው።');
      return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('ℹ️ አጠቃቀም: `/confirm_paid <order_id>`', { parse_mode: 'Markdown' });
      return;
    }

    const orderId = parseInt(parts[1].replace('#', ''), 10);
    if (isNaN(orderId)) {
      await ctx.reply('⚠️ ትክክለኛ ያልሆነ ኦርደር ቁጥር ነው።');
      return;
    }

    const order = await db.getOrder(orderId);
    if (!order) {
      await ctx.reply(`ኦርደር #${orderId} አልተገኘም።`);
      return;
    }

    if (order.status !== 'pending_audit') {
      await ctx.reply(`ኦርደር #${orderId} በአሁን ሰዓት '${order.status}' ላይ ስለሆነ ማረጋገጥ አይቻልም።`);
      return;
    }

    const updated = await db.updateOrderStatus(orderId, 'completed');
    const roleTitle = isManager ? 'ማናጀር' : 'ፋይናንስ';

    await ctx.reply(`✅ *ኦርደር #${orderId} ተረጋግጧል!*\nክፍያው በ ${roleTitle} (${user.name}) ተረጋግጧል።`, {
      parse_mode: 'Markdown',
    });

    try {
      await bot.telegram.sendMessage(
        updated.sales_id,
        `🎉 *ኦርደር #${updated.id} ተረጋግጧል!*\n\n` +
        `*${roleTitle}* (*${user.name}*) ለ *${escapeMarkdown(updated.client_name)}* የተላከውን ክፍያ አረጋግጠዋል።\n` +
        `ጠቅላላ ዋጋ: *${formatCurrency(updated.total_amount)}*\n` +
        `ሁኔታ: *ተጠናቋል*.`,
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
      await ctx.reply('⛔ ችግር ሪፖርት ማድረግ የሚችሉት ፋይናንስ ወይም ማናጀር ብቻ ናቸው።');
      return;
    }

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply('ℹ️ አጠቃቀም: `/flag_payment <order_id>`', { parse_mode: 'Markdown' });
      return;
    }

    const orderId = parseInt(parts[1].replace('#', ''), 10);
    if (isNaN(orderId)) {
      await ctx.reply('⚠️ ትክክለኛ ያልሆነ ኦርደር ቁጥር ነው።');
      return;
    }

    const order = await db.getOrder(orderId);
    if (!order) {
      await ctx.reply(`ኦርደር #${orderId} አልተገኘም።`);
      return;
    }

    if (order.status !== 'pending_audit') {
      await ctx.reply(`ኦርደር #${orderId} በአሁን ሰዓት '${order.status}' ላይ ነው።`);
      return;
    }

    const updated = await db.updateOrderStatus(orderId, 'dispatched');
    const roleTitle = isManager ? 'ማናጀር' : 'ፋይናንስ';

    await ctx.reply(`⚠️ *ኦርደር #${orderId} ችግር ሪፖርት ተደርጓል።*\nሴልስ ሬፕ ደረሰኝ በድጋሚ እንዲልክ ተጠይቋል።`, {
      parse_mode: 'Markdown',
    });

    try {
      await bot.telegram.sendMessage(
        updated.sales_id,
        `⚠️ *በስሊፕ ላይ ችግር ተገኝቷል*\n\n` +
        `*${roleTitle}* (*${user.name}*) የኦርደር #${updated.id} ክፍያን አይተው ችግር እንዳለ ጠቁመዋል።\n\n` +
        `እባክዎ የባንክ ክፍያውን አረጋግጠው ትክክለኛውን ስሊፕ ከታች በድጋሚ ይላኩ:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: `💳 ስሊፕ በድጋሚ ላክ`,
                  callback_data: `start_slip_${updated.id}`,
                },
              ],
            ],
          },
        }
      );
    } catch {}
  });

  // Handle keyboard button text: '💳 ያልተረጋገጡ ክፍያዎች' / '💳 Pending Payments'
  bot.hears(['💳 ያልተረጋገጡ ክፍያዎች', '💳 Pending Payments'], async (ctx) => {
    await showPendingAudits(ctx);
  });
}

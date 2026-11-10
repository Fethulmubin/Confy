import { Telegraf, Markup } from 'telegraf';
import { db } from '../supabase';
import { config } from '../config';
import { authenticateUser } from '../middleware/auth';
import { getSession, setSession, clearSession } from '../state';
import { escapeMarkdown, formatCurrency, getStatusBadge, cleanItemDetailsForSales, extractStoreExpenseHistory } from '../utils';

export function registerSalesHandlers(bot: Telegraf): void {
  // Guard helper for 1-on-1 private chat
  async function ensurePrivateSales(ctx: any): Promise<boolean> {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('⚠️ Sales interactions must be conducted in a direct 1-on-1 private chat with the bot.');
      return false;
    }
    const user = await authenticateUser(ctx);
    if (!user) return false;

    const isManager = user.roles.includes('manager') || user.role === 'manager';
    const isSales = user.roles.includes('sales') || user.activeRole === 'sales';

    if (!isManager && !isSales) {
      await ctx.reply(
        `⛔ *ፈቃድ የለዎትም (Permission Denied)*\n\nይህ ተግባር ለ Sales Representatives ብቻ የተፈቀደ ነው።\nየእርስዎ Active Role: *${user.activeRole.toUpperCase()}*`,
        { parse_mode: 'Markdown' }
      );
      return false;
    }
    return true;
  }

  // /new_order command & button
  const startNewOrderWizard = async (ctx: any) => {
    if (!(await ensurePrivateSales(ctx))) return;

    setSession(ctx.from.id, {
      type: 'create_order',
      draft: { step: 'waiting_client' },
    });

    await ctx.reply(
      `📝 *አዲስ Order መመዝገቢያ (ደረጃ 1/3)*\n\n` +
      `እባክዎ የ *Client ስም* ያስገቡ:\n\n` +
      `_(በማንኛውም ሰዓት ለማቋረጥ /cancel ይበሉ)_`,
      { parse_mode: 'Markdown' }
    );
  };

  bot.command('new_order', startNewOrderWizard);
  bot.hears('➕ New Order', startNewOrderWizard);

  // /my_orders command & button
  const handleMyOrders = async (ctx: any) => {
    if (!(await ensurePrivateSales(ctx))) return;

    try {
      const orders = await db.getOrdersBySalesId(ctx.from.id, 10);
      if (orders.length === 0) {
        await ctx.reply(
          `📋 ምንም Order የለዎትም።\n\nአዲስ order ለመመዝገብ /new_order ይጠቀሙ ወይም ከታች ያለውን button ይጫኑ።`
        );
        return;
      }

      let messageText = `📋 *የቅርብ Order-ኦችዎ:*\n\n`;
      const buttons: any[] = [];

      orders.forEach((o) => {
        const cleanItems = cleanItemDetailsForSales(o.item_details);
        messageText +=
          `*Order #${o.id}* — ${getStatusBadge(o.status)}\n` +
          `> 👤 *Client:* ${escapeMarkdown(o.client_name)}\n` +
          `> 💰 *Total:* ${formatCurrency(o.total_amount)}\n` +
          `> 📦 *Items:* ${escapeMarkdown(cleanItems)}\n\n`;

        // If order was dispatched, offer quick upload button
        if (o.status === 'dispatched') {
          buttons.push([
            Markup.button.callback(`💳 የ #${o.id} Slip ላክ`, `start_slip_${o.id}`),
          ]);
        }
      });

      if (buttons.length > 0) {
        await ctx.reply(messageText, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(buttons),
        });
      } else {
        await ctx.reply(messageText, { parse_mode: 'Markdown' });
      }
    } catch (err: any) {
      console.error('[Sales] Error fetching orders:', err);
      await ctx.reply('⚠️ Order-ኦችን ማምጣት አልተቻለም። እባክዎ በድጋሚ ይሞክሩ።');
    }
  };

  bot.command('my_orders', handleMyOrders);
  bot.hears('📋 My Orders', handleMyOrders);

  // Command to initiate slip upload: /upload_slip <id>
  bot.command('upload_slip', async (ctx) => {
    if (!(await ensurePrivateSales(ctx))) return;

    const parts = ctx.message.text.split(' ');
    const orderId = parts.length > 1 ? parseInt(parts[1], 10) : NaN;

    if (isNaN(orderId)) {
      await ctx.reply('አጠቃቀም: /upload_slip <order_id>\nምሳሌ: /upload_slip 104');
      return;
    }

    await initiateSlipUpload(ctx, orderId);
  });

  // Callback to start payment slip upload
  bot.action(/^start_slip_(\d+)$/, async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user) return;

    if (user.role !== 'sales') {
      await ctx.answerCbQuery('ይህ ለ Sales Representative ብቻ የተፈቀደ ነው።', {
        show_alert: true,
      });
      return;
    }

    const orderId = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    await initiateSlipUpload(ctx, orderId);
  });

  async function initiateSlipUpload(ctx: any, orderId: number) {
    try {
      const order = await db.getOrder(orderId);
      if (!order) {
        await ctx.reply(`Order #${orderId} አልተገኘም።`);
        return;
      }

      if (order.sales_id !== ctx.from.id) {
        await ctx.reply('⛔ የራስዎን order ብቻ ነው Payment Slip መላክ የሚችሉት።');
        return;
      }

      if (order.status !== 'dispatched') {
        await ctx.reply(
          `⚠️ የ Order #${order.id} status '${order.status}' ስለሆነ slip መላክ አይቻልም።\n` +
          `Payment Slip መላክ የሚቻለው ዕቃቸው Dispatched ለሆኑ order-ኦች ብቻ ነው።`
        );
        return;
      }

      setSession(ctx.from.id, {
        type: 'upload_slip',
        orderId: order.id,
      });

      await ctx.reply(
        `📸 *የ Payment Slip መላኪያ — Order #${order.id}*\n\n` +
        `> 👤 *Client:* *${escapeMarkdown(order.client_name)}*\n` +
        `> 💰 *የሚጠበቅ ክፍያ:* *${formatCurrency(order.total_amount)}*\n\n` +
        `እባክዎ የባንክ screenshot ወይም የተከፈለበትን Receipt ፎቶ አሁን ይላኩ።\n` +
        `_(ለማቋረጥ /cancel)_`,
        { parse_mode: 'Markdown' }
      );
    } catch (err: any) {
      console.error(`[Sales] Error initiating slip upload for order #${orderId}:`, err);
      await ctx.reply('⚠️ የ Slip መላኪያ ማዘጋጀት አልተቻለም።');
    }
  }

  // Handle wizard confirmation callbacks
  bot.action('confirm_new_order', async (ctx) => {
    const session = getSession(ctx.from.id);
    if (!session || session.type !== 'create_order' || session.draft.step !== 'confirming') {
      await ctx.answerCbQuery('Session አልቋል። እባክዎ በ /new_order እንደገና ይጀምሩ።');
      return;
    }

    const draft = session.draft;
    clearSession(ctx.from.id);

    try {
      const salesUser = await db.getUser(ctx.from.id);
      const repName = salesUser?.name || 'Sales Rep';

      // 1. Insert order into Supabase
      const newOrder = await db.createOrder({
        sales_id: ctx.from.id,
        client_name: draft.clientName!,
        item_details: draft.itemDetails!,
        total_amount: draft.totalAmount!,
        status: 'pending_approval',
      });

      await ctx.answerCbQuery('Order በተሳካ ሁኔታ ተፈጥሯል!');

      // 2. Respond to sales rep in private chat
      const confirmText =
        `✅ *Order #${newOrder.id} ተልኳል!*\n\n` +
        `> 👤 *Client:* ${escapeMarkdown(newOrder.client_name)}\n` +
        `> 💰 *ጠቅላላ ዋጋ:* ${formatCurrency(newOrder.total_amount)}\n` +
        `> ⏳ *Status:* Manager Approval በመጠበቅ ላይ`;

      try {
        await ctx.editMessageText(confirmText, { parse_mode: 'Markdown' });
      } catch {
        await ctx.reply(confirmText, { parse_mode: 'Markdown' });
      }

      // 3. Dispatch inline card to Manager Gate (#Orders Topic / Group)
      const managerCard =
        `📑 *አዲስ Order Requisition: #${newOrder.id}*\n\n` +
        `> 💼 *Sales Rep:* ${escapeMarkdown(repName)}\n` +
        `> 👤 *Client:* ${escapeMarkdown(newOrder.client_name)}\n` +
        `> 📦 *Items:* ${escapeMarkdown(newOrder.item_details)}\n` +
        `> 💰 *ጠቅላላ ዋጋ:* *${formatCurrency(newOrder.total_amount)}*\n\n` +
        `👇 *የ Manager ውሳኔ ይጠበቃል:*`;

      await bot.telegram.sendMessage(
        config.ordersChatId,
        managerCard,
        {
          parse_mode: 'Markdown',
          message_thread_id: config.ordersThreadId,
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve (ልቀቁ)', callback_data: `approve_order_${newOrder.id}` },
                { text: '❌ Reject (ሰርዝ)', callback_data: `reject_order_${newOrder.id}` },
              ],
            ],
          },
        }
      );
    } catch (err: any) {
      console.error('[Sales] Error creating order:', err);
      await ctx.reply('⚠️ Order ማስቀመጥ አልተቻለም። እባክዎ በድጋሚ ይሞክሩ።');
    }
  });

  bot.action('cancel_new_order', async (ctx) => {
    clearSession(ctx.from.id);
    await ctx.answerCbQuery('Order ተሰርዟል።');
    try {
      await ctx.editMessageText('❌ የ Order ምዝገባው ተሰርዟል።');
    } catch {
      await ctx.reply('❌ የ Order ምዝገባው ተሰርዟል።');
    }
  });

  // Handle text input during order wizard
  bot.on('text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();

    const session = getSession(ctx.from.id);
    if (!session || session.type !== 'create_order') {
      return next();
    }

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      return next(); // Let commands handle themselves
    }

    const draft = session.draft;

    switch (draft.step) {
      case 'waiting_client': {
        draft.clientName = text;
        draft.step = 'waiting_items';
        await ctx.reply(
          `📝 *አዲስ Order መመዝገቢያ (ደረጃ 2/3)*\n\n` +
          `> 👤 *Client:* *${escapeMarkdown(draft.clientName)}*\n\n` +
          `እባክዎ የ *ዕቃዎች ዝርዝር (Items)* ያስገቡ (ምሳሌ: 50x ሲሚንቶ):\n\n` +
          `_(ለማቋረጥ /cancel)_`,
          { parse_mode: 'Markdown' }
        );
        break;
      }

      case 'waiting_items': {
        draft.itemDetails = text;
        draft.step = 'waiting_amount';
        await ctx.reply(
          `📝 *አዲስ Order መመዝገቢያ (ደረጃ 3/3)*\n\n` +
          `> 👤 *Client:* *${escapeMarkdown(draft.clientName)}*\n` +
          `> 📦 *Items:* *${escapeMarkdown(draft.itemDetails)}*\n\n` +
          `እባክዎ *ጠቅላላ ዋጋ በ ETB* ያስገቡ (ቁጥር ብቻ, ምሳሌ: 12500):`,
          { parse_mode: 'Markdown' }
        );
        break;
      }

      case 'waiting_amount': {
        const cleaned = text.replace(/[^0-9.]/g, '');
        const amount = parseFloat(cleaned);

        if (isNaN(amount) || amount <= 0) {
          await ctx.reply(
            `⚠️ እባክዎ ትክክለኛ የብር መጠን በቁጥር ብቻ ያስገቡ (ምሳሌ: 12500):`
          );
          return;
        }

        draft.totalAmount = amount;
        draft.step = 'confirming';

        const summary =
          `📋 *የ Order ማረጋገጫ (Confirmation)*\n\n` +
          `> 👤 *Client:* ${escapeMarkdown(draft.clientName)}\n` +
          `> 📦 *Items:* ${escapeMarkdown(draft.itemDetails)}\n` +
          `> 💰 *ጠቅላላ ዋጋ:* ${formatCurrency(draft.totalAmount)}\n\n` +
          `ይህ Order ለ Manager approval እንዲላክ ይፈልጋሉ?`;

        await ctx.reply(summary, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Confirm & Submit', 'confirm_new_order'),
              Markup.button.callback('❌ Cancel', 'cancel_new_order'),
            ],
          ]),
        });
        break;
      }

      default:
        return next();
    }
  });

  // Handle sales rep photo upload in 1-on-1 private chat (Phase 4)
  bot.on('photo', async (ctx, next) => {
    if (ctx.chat.type !== 'private') {
      return next(); // Group photos are handled by storekeeper flow
    }

    const telegramId = ctx.from.id;
    const session = getSession(telegramId);
    let targetOrderId: number | null = null;

    if (session && session.type === 'upload_slip') {
      targetOrderId = session.orderId;
    } else if (ctx.message.caption) {
      // Check if order ID is specified in caption, e.g. #104 or 104
      const match = ctx.message.caption.match(/(?:Order\s*#?|#)(\d+)/i);
      if (match) {
        targetOrderId = parseInt(match[1], 10);
      }
    }

    // If still not specified, check if the sales rep has exactly one dispatched order
    if (!targetOrderId) {
      try {
        const dispatchedOrders = (await db.getOrdersBySalesId(telegramId, 5)).filter(
          (o) => o.status === 'dispatched'
        );
        if (dispatchedOrders.length === 1) {
          targetOrderId = dispatchedOrders[0].id;
        }
      } catch (err) {
        // Ignore fallback error
      }
    }

    if (!targetOrderId) {
      await ctx.reply(
        `⚠️ እባክዎ ይህ Payment Slip ለየትኛው order እንደሆነ ይጥቀሱ።\n\n` +
        `/upload_slip <order_id> ይጠቀሙ ወይም በ /my_orders ውስጥ [ Slip ላክ ] የሚለውን ይጫኑ።`
      );
      return;
    }

    try {
      const order = await db.getOrder(targetOrderId);
      if (!order) {
        await ctx.reply(`Order #${targetOrderId} አልተገኘም።`);
        return;
      }

      if (order.sales_id !== telegramId) {
        await ctx.reply('⛔ የራስዎን order ብቻ ነው Payment Slip መላክ የሚችሉት።');
        return;
      }

      if (order.status !== 'dispatched') {
        await ctx.reply(
          `⚠️ የ Order #${order.id} status '${order.status}' ስለሆነ slip መላክ አይቻልም።\n` +
          `Payment Slip መላክ የሚቻለው ዕቃቸው Dispatched ለሆኑ order-ኦች ብቻ ነው።`
        );
        return;
      }

      // Capture native Telegram file_id
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const slipFileId = photo.file_id;

      // Update Supabase: save payment_slip_file_id and set status to 'pending_audit'
      const updatedOrder = await db.setPaymentSlip(order.id, slipFileId);
      clearSession(telegramId);

      // Confirm to sales rep in 1-on-1 private chat
      await ctx.reply(
        `✅ *የ Payment Slip ደርሷል — Order #${updatedOrder.id}*\n\n` +
        `> 👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
        `> 💰 *የተከፈለ መጠን:* *${formatCurrency(updatedOrder.total_amount)}*\n` +
        `> 🔍 *Status:* Finance Audit በመጠበቅ ላይ\n\n` +
        `📨 _የባንክ ማስተላለፊያ ደረሰኝ ለ Finance ተልኳል። እንደተረጋገጠ መልእክት ይደርስዎታል!_`,
        { parse_mode: 'Markdown' }
      );

      // Fetch sales rep name for Finance card
      const salesUser = await db.getUser(telegramId);
      const repName = salesUser?.name || `Rep ID ${telegramId}`;
      const expenseHistory = extractStoreExpenseHistory(updatedOrder.item_details);
      const expenseLine = expenseHistory ? `\n> 🚚 *Store Dispatch Cost:* \`${escapeMarkdown(expenseHistory)}\`` : '';

      // Forward ONLY to #Finance Topic with native photo and reconciliation card
      const financeCaption =
        `💳 *Payment Audit: Order #${updatedOrder.id}*\n\n` +
        `> 👤 *Client:* ${escapeMarkdown(updatedOrder.client_name)}\n` +
        `> 💼 *Sales Rep:* ${escapeMarkdown(repName)}\n` +
        `> 💰 *የሚጠበቅ መጠን:* *${formatCurrency(updatedOrder.total_amount)}*\n` +
        `> 📦 *Items:* ${escapeMarkdown(cleanItemDetailsForSales(updatedOrder.item_details))}` +
        expenseLine +
        `\n\n👇 *Finance / Manager:* የባንክ screenshot በማረጋገጥ ከታች ይምረጡ:`;

      await bot.telegram.sendPhoto(
        config.financeChatId,
        slipFileId,
        {
          caption: financeCaption,
          message_thread_id: config.financeThreadId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Confirm Paid (ተከፍሏል)', callback_data: `finance_confirm_${updatedOrder.id}` },
                { text: '⚠️ Flag Discrepancy (ችግር አለ)', callback_data: `finance_flag_${updatedOrder.id}` },
              ],
            ],
          },
        }
      );
    } catch (err: any) {
      console.error(`[Sales] Error saving payment slip for order #${targetOrderId}:`, err);
      await ctx.reply('⚠️ የ Payment Slip ማስቀመጥ አልተቻለም። እባክዎ በድጋሚ ይሞክሩ።');
    }
  });
}

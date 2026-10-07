import { Telegraf, Markup } from 'telegraf';
import { db } from '../supabase';
import { config } from '../config';
import { authenticateUser } from '../middleware/auth';
import { getSession, setSession, clearSession } from '../state';
import { escapeMarkdown, formatCurrency, getStatusBadge } from '../utils';

export function registerSalesHandlers(bot: Telegraf): void {
  // Guard helper for 1-on-1 private chat
  async function ensurePrivateSales(ctx: any): Promise<boolean> {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('⚠️ Sales interactions must be conducted in a direct 1-on-1 private chat with the bot.');
      return false;
    }
    const user = await authenticateUser(ctx);
    if (!user) return false;

    if (user.role !== 'sales') {
      await ctx.reply(
        `⛔ *Permission Denied*\n\nThis function is restricted to Sales Representatives.\nYour role: *${user.role.toUpperCase()}*`,
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
      `📝 *New Order Requisition (Step 1/3)*\n\n` +
      `Please enter the *Client Name*:\n\n` +
      `_(Type /cancel to abort at any time)_`,
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
          `📋 You have no active or previous orders.\n\nType /new_order or tap the button to create your first order.`
        );
        return;
      }

      let messageText = `📋 *Your Recent Orders:*\n\n`;
      const buttons: any[] = [];

      orders.forEach((o) => {
        messageText +=
          `• *Order #${o.id}* — ${escapeMarkdown(o.client_name)}\n` +
          `  Total: ${formatCurrency(o.total_amount)}\n` +
          `  Items: ${escapeMarkdown(o.item_details)}\n` +
          `  Status: ${getStatusBadge(o.status)}\n\n`;

        // If order was dispatched, offer quick upload button
        if (o.status === 'dispatched') {
          buttons.push([
            Markup.button.callback(`💳 Upload Slip for #${o.id}`, `start_slip_${o.id}`),
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
      await ctx.reply('⚠️ Failed to fetch your orders. Please try again.');
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
      await ctx.reply('Usage: /upload_slip <order_id>\nExample: /upload_slip 104');
      return;
    }

    await initiateSlipUpload(ctx, orderId);
  });

  // Callback to start payment slip upload
  bot.action(/^start_slip_(\d+)$/, async (ctx) => {
    const user = await authenticateUser(ctx);
    if (!user) return;

    if (user.role !== 'sales') {
      await ctx.answerCbQuery('Access denied: Sales representatives only.', {
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
        await ctx.reply(`Order #${orderId} not found.`);
        return;
      }

      if (order.sales_id !== ctx.from.id) {
        await ctx.reply('⛔ You can only submit payment slips for your own orders.');
        return;
      }

      if (order.status !== 'dispatched') {
        await ctx.reply(
          `⚠️ Order #${orderId} is currently '${order.status}'.\n` +
          `Payment slips can only be submitted for dispatched orders.`
        );
        return;
      }

      setSession(ctx.from.id, {
        type: 'upload_slip',
        orderId: order.id,
      });

      await ctx.reply(
        `📸 *Payment Slip Submission for Order #${order.id}*\n\n` +
        `Client: *${escapeMarkdown(order.client_name)}*\n` +
        `Expected Amount: *${formatCurrency(order.total_amount)}*\n\n` +
        `Please upload the bank transfer screenshot or receipt photo now.\n` +
        `_(Type /cancel to abort)_`,
        { parse_mode: 'Markdown' }
      );
    } catch (err: any) {
      console.error(`[Sales] Error initiating slip upload for order #${orderId}:`, err);
      await ctx.reply('⚠️ Error preparing slip submission.');
    }
  }

  // Handle wizard confirmation callbacks
  bot.action('confirm_new_order', async (ctx) => {
    const session = getSession(ctx.from.id);
    if (!session || session.type !== 'create_order' || session.draft.step !== 'confirming') {
      await ctx.answerCbQuery('Session expired. Please restart with /new_order.');
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

      await ctx.answerCbQuery('Order created successfully!');

      // 2. Respond to sales rep in private chat
      try {
        await ctx.editMessageText(
          `Order #${newOrder.id} submitted. Awaiting manager approval.`
        );
      } catch {
        await ctx.reply(
          `Order #${newOrder.id} submitted. Awaiting manager approval.`
        );
      }

      // 3. Dispatch inline card to Manager Gate (#Orders Topic / Group)
      const managerCard =
        `New Requisition: Order #${newOrder.id}\n` +
        `Sales Rep: ${repName} | Total: ${formatCurrency(newOrder.total_amount)}\n` +
        `Items: ${newOrder.item_details}`;

      await bot.telegram.sendMessage(
        config.ordersChatId,
        managerCard,
        {
          message_thread_id: config.ordersThreadId,
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Approve', callback_data: `approve_order_${newOrder.id}` },
                { text: 'Reject', callback_data: `reject_order_${newOrder.id}` },
              ],
            ],
          },
        }
      );
    } catch (err: any) {
      console.error('[Sales] Error creating order:', err);
      await ctx.reply('⚠️ Failed to save order to database. Please try again.');
    }
  });

  bot.action('cancel_new_order', async (ctx) => {
    clearSession(ctx.from.id);
    await ctx.answerCbQuery('Order creation cancelled.');
    try {
      await ctx.editMessageText('❌ Order requisition cancelled.');
    } catch {
      await ctx.reply('❌ Order requisition cancelled.');
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
          `📝 *New Order Requisition (Step 2/3)*\n\n` +
          `Client: *${escapeMarkdown(draft.clientName)}*\n\n` +
          `Please enter the *Item Details* (e.g. 50x Product A):\n\n` +
          `_(Type /cancel to abort)_`,
          { parse_mode: 'Markdown' }
        );
        break;
      }

      case 'waiting_items': {
        draft.itemDetails = text;
        draft.step = 'waiting_amount';
        await ctx.reply(
          `📝 *New Order Requisition (Step 3/3)*\n\n` +
          `Client: *${escapeMarkdown(draft.clientName)}*\n` +
          `Items: *${escapeMarkdown(draft.itemDetails)}*\n\n` +
          `Please enter the *Total Amount* in ETB (numbers only, e.g. 12500):`,
          { parse_mode: 'Markdown' }
        );
        break;
      }

      case 'waiting_amount': {
        const cleaned = text.replace(/[^0-9.]/g, '');
        const amount = parseFloat(cleaned);

        if (isNaN(amount) || amount <= 0) {
          await ctx.reply(
            `⚠️ Please enter a valid positive numeric amount (e.g. 12500):`
          );
          return;
        }

        draft.totalAmount = amount;
        draft.step = 'confirming';

        const summary =
          `📋 *Order Confirmation*\n\n` +
          `👤 *Client:* ${escapeMarkdown(draft.clientName)}\n` +
          `📦 *Items:* ${escapeMarkdown(draft.itemDetails)}\n` +
          `💰 *Total Amount:* ${formatCurrency(draft.totalAmount)}\n\n` +
          `Would you like to submit this requisition for manager approval?`;

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
        `⚠️ Please specify which order this payment slip is for.\n\n` +
        `Use /upload_slip <order_id> or tap [ Upload Slip ] under /my_orders.`
      );
      return;
    }

    try {
      const order = await db.getOrder(targetOrderId);
      if (!order) {
        await ctx.reply(`Order #${targetOrderId} not found.`);
        return;
      }

      if (order.sales_id !== telegramId) {
        await ctx.reply('⛔ You can only upload payment slips for your own orders.');
        return;
      }

      if (order.status !== 'dispatched') {
        await ctx.reply(
          `⚠️ Order #${order.id} is currently '${order.status}'.\n` +
          `A payment slip can only be submitted for dispatched orders awaiting payment.`
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
        `✅ *Payment Slip Received for Order #${updatedOrder.id}*\n\n` +
        `The bank transfer slip has been forwarded to the Finance department for audit and settlement.`,
        { parse_mode: 'Markdown' }
      );

      // Fetch sales rep name for Finance card
      const salesUser = await db.getUser(telegramId);
      const repName = salesUser?.name || `Rep ID ${telegramId}`;

      // Forward to #Finance Topic with native photo and reconciliation card
      const financeCaption =
        `Payment Audit: Order #${updatedOrder.id}\n` +
        `Sales Rep: ${repName} | Expected: ${formatCurrency(updatedOrder.total_amount)}\n` +
        `[Photo: Attached Bank Screenshot]`;

      await bot.telegram.sendPhoto(
        config.financeChatId,
        slipFileId,
        {
          caption: financeCaption,
          message_thread_id: config.financeThreadId,
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Confirm Paid', callback_data: `finance_confirm_${updatedOrder.id}` },
                { text: 'Flag Discrepancy', callback_data: `finance_flag_${updatedOrder.id}` },
              ],
            ],
          },
        }
      );
    } catch (err: any) {
      console.error(`[Sales] Error saving payment slip for order #${targetOrderId}:`, err);
      await ctx.reply('⚠️ Failed to save payment slip. Please try again.');
    }
  });
}

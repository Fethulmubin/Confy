import { Telegraf } from 'telegraf';
import express from 'express';
import { config, validateConfig } from './config';
import { db } from './supabase';
import { registerStartHandlers } from './handlers/start';
import { registerSalesHandlers } from './handlers/sales';
import { registerManagerHandlers } from './handlers/manager';
import { registerStoreHandlers } from './handlers/store';
import { registerFinanceHandlers } from './handlers/finance';

// 1. Validate configuration
validateConfig();

// 2. Create Express server for health checks & platform keep-alive
const app = express();

app.get('/', (_, res) => {
  res.json({
    status: 'online',
    service: 'Telegram Order Processing Bot',
    uptime: process.uptime(),
  });
});

app.get('/health', (_, res) => {
  res.status(200).send('OK');
});

const server = app.listen(config.port, () => {
  console.log(`🚀 Express server running on port ${config.port}`);
});

// 3. Initialize Telegraf bot
const bot = new Telegraf(config.botToken);

// 4. Global error handling
bot.catch((err: any, ctx) => {
  console.error(`❌ [Telegraf Error] Update ${ctx.update.update_id}:`, err);
  try {
    if (ctx.callbackQuery) {
      ctx.answerCbQuery('⚠️ An unexpected error occurred. Please try again.').catch(() => {});
    } else {
      ctx.reply('⚠️ An unexpected error occurred. Please try again.').catch(() => {});
    }
  } catch (replyErr) {
    console.error('Failed to send error notification:', replyErr);
  }
});

// 5. Register modular handlers
registerStartHandlers(bot);
registerManagerHandlers(bot);
registerStoreHandlers(bot);
registerFinanceHandlers(bot);
registerSalesHandlers(bot);

// 6. Bootstrap Initial Manager if MANAGER_TELEGRAM_ID is configured in .env
async function bootstrapManager(): Promise<void> {
  if (config.managerTelegramId) {
    try {
      const existing = await db.getUser(config.managerTelegramId);
      if (!existing) {
        await db.upsertUser({
          telegram_id: config.managerTelegramId,
          name: 'Primary Manager',
          role: 'manager',
        });
        console.log(`👑 Bootstrapped initial Manager Telegram ID: ${config.managerTelegramId}`);
      } else if (existing.role !== 'manager') {
        await db.upsertUser({
          telegram_id: config.managerTelegramId,
          name: existing.name,
          role: 'manager',
        });
        console.log(`👑 Promoted Telegram ID ${config.managerTelegramId} to Manager.`);
      }
    } catch (err: any) {
      console.warn(`[Bootstrap Manager] Note: Could not auto-bootstrap manager: ${err.message}`);
    }
  }
}

// 7. Launch bot
bootstrapManager()
  .then(() => bot.launch())
  .then(() => {
    console.log('🤖 Telegram Bot started and listening for events...');
    console.log(`📍 Topic Routing:`);
    console.log(`   #Orders  Chat: ${config.ordersChatId} (Thread: ${config.ordersThreadId ?? 'none'})`);
    console.log(`   #Store   Chat: ${config.storeChatId} (Thread: ${config.storeThreadId ?? 'none'})`);
    console.log(`   #Finance Chat: ${config.financeChatId} (Thread: ${config.financeThreadId ?? 'none'})`);
  })
  .catch((err) => {
    console.error('Failed to launch Telegram bot:', err);
  });

// 8. Graceful shutdown
process.once('SIGINT', () => {
  console.log('Stopping bot on SIGINT...');
  bot.stop('SIGINT');
  server.close();
});

process.once('SIGTERM', () => {
  console.log('Stopping bot on SIGTERM...');
  bot.stop('SIGTERM');
  server.close();
});
console.log("Bot started...");
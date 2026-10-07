import * as dotenv from 'dotenv';

dotenv.config();

function getEnvNumber(key: string): number | undefined {
  const val = process.env[key];
  if (!val) return undefined;
  const num = parseInt(val, 10);
  return isNaN(num) ? undefined : num;
}

export const config = {
  botToken: process.env.BOT_TOKEN || '',
  port: getEnvNumber('PORT') || 3000,

  // Supabase
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey:
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    '',

  // Bootstrap initial manager ID
  managerTelegramId: getEnvNumber('MANAGER_TELEGRAM_ID'),

  // Channels / Topics
  adminGroupId: process.env.ADMIN_GROUP_ID || '',

  get ordersChatId(): string {
    return process.env.ORDERS_CHAT_ID || this.adminGroupId;
  },
  ordersThreadId: getEnvNumber('ORDERS_THREAD_ID'),

  get storeChatId(): string {
    return process.env.STORE_CHAT_ID || this.adminGroupId;
  },
  storeThreadId: getEnvNumber('STORE_THREAD_ID'),

  get financeChatId(): string {
    return process.env.FINANCE_CHAT_ID || this.adminGroupId;
  },
  financeThreadId: getEnvNumber('FINANCE_THREAD_ID'),
};

export function validateConfig(): void {
  if (!config.botToken) {
    throw new Error('BOT_TOKEN is missing in environment variables (.env).');
  }

  if (!config.supabaseUrl || !config.supabaseKey) {
    console.warn(
      '⚠️ [Config Warning] SUPABASE_URL or SUPABASE_KEY is missing in .env.\n' +
      'Database operations will fail until Supabase credentials are configured.'
    );
  }

  if (!config.adminGroupId && !config.ordersChatId) {
    console.warn(
      '⚠️ [Config Warning] ADMIN_GROUP_ID or ORDERS_CHAT_ID is not set in .env.\n' +
      'Group notifications for managers, store, and finance will need a valid chat ID.'
    );
  }
}


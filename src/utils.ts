import { OrderStatus } from './types';

/**
 * Escapes characters for Telegram Markdown (v1)
 */
export function escapeMarkdown(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/([_*`\[\]])/g, '\\$1');
}

/**
 * Formats a number as ETB currency string, e.g. 12,500 ETB
 */
export function formatCurrency(amount: number): string {
  return `${Number(amount).toLocaleString('en-US')} ETB`;
}

/**
 * Formats a timestamp into a readable time string, e.g. 10:15 AM
 */
export function formatTime(date: Date = new Date()): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Returns human-friendly status label with emoji
 */
export function getStatusBadge(status: OrderStatus): string {
  switch (status) {
    case 'pending_approval':
      return '⏳ የማናጀር ማረጋገጫ በመጠበቅ ላይ';
    case 'pending_dispatch':
      return '📦 ጸድቋል (ከስቶር መውጣት በመጠበቅ ላይ)';
    case 'dispatched':
      return '🚚 ከስቶር ወጥቷል (ስሊፕ በመጠበቅ ላይ)';
    case 'pending_audit':
      return '🔍 ስሊፕ ገብቷል (ፋይናንስ ማረጋገጥ አለበት)';
    case 'completed':
      return '✅ ተጠናቋል';
    case 'cancelled':
      return '❌ ተሰርዟል';
    default:
      return status;
  }
}

/**
 * Strips internal store dispatch expense notes from item details so sales reps don't see them
 */
export function cleanItemDetailsForSales(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\n?\[(?:Store Paid Dispatch|\+ Dispatch Expense):.*?\]/gi, '').trim();
}

/**
 * Extracts store dispatch expense note if present in item details
 */
export function extractStoreExpenseHistory(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/\[(?:Store Paid Dispatch|\+ Dispatch Expense):\s*(.*?)\]/i);
  return match ? match[1] : null;
}

/**
 * Extracts order numeric ID from text containing variations like:
 * "ኦርደር #123", "Order #123", "ኦርደር 123", "Order 123", "ኦርደር#123", "#123"
 */
export function extractOrderId(text: string | null | undefined): number | null {
  if (!text) return null;
  const m1 = text.match(/(?:Order|ኦርደር)\s*#?\s*(\d+)/i);
  if (m1) return parseInt(m1[1], 10);

  const m2 = text.match(/#(\d+)/);
  if (m2) return parseInt(m2[1], 10);

  return null;
}


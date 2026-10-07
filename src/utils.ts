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
      return '⏳ Awaiting Manager Approval';
    case 'pending_dispatch':
      return '📦 Approved (Pending Store Dispatch)';
    case 'dispatched':
      return '🚚 Dispatched (Awaiting Payment Slip)';
    case 'pending_audit':
      return '🔍 Payment Submitted (Under Finance Audit)';
    case 'completed':
      return '✅ Completed & Settled';
    case 'cancelled':
      return '❌ Cancelled / Rejected';
    default:
      return status;
  }
}

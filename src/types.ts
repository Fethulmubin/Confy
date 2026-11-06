export type UserRole = 'manager' | 'store' | 'finance' | 'sales';

export type OrderStatus =
  | 'pending_approval'
  | 'pending_dispatch'
  | 'dispatched'
  | 'pending_audit'
  | 'completed'
  | 'cancelled';

export interface User {
  telegram_id: number;
  name: string;
  role: UserRole; // primary role in DB
  roles: UserRole[]; // all assigned roles
  activeRole: UserRole; // currently active role session
  cleanName: string; // display name without role tags
  username?: string | null;
  created_at?: string;
}

export interface Order {
  id: number;
  sales_id: number;
  client_name: string;
  item_details: string;
  total_amount: number;
  status: OrderStatus;
  store_receipt_file_id?: string | null;
  payment_slip_file_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface CreateOrderDraft {
  step: 'waiting_client' | 'waiting_items' | 'waiting_amount' | 'confirming';
  clientName?: string;
  itemDetails?: string;
  totalAmount?: number;
}

export interface AddUserDraft {
  step: 'waiting_identity';
  identifier?: string;
  name?: string;
  resolvedTelegramId?: number;
}

export type UserSession =
  | { type: 'create_order'; draft: CreateOrderDraft }
  | { type: 'upload_slip'; orderId: number }
  | { type: 'add_user'; draft: AddUserDraft };
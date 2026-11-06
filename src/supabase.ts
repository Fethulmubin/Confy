import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';
import { User, UserRole, Order, OrderStatus } from './types';
import { getActiveRole } from './state';

let supabaseClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!supabaseClient) {
    if (!config.supabaseUrl || !config.supabaseKey) {
      throw new Error(
        'Supabase is not configured. Please provide SUPABASE_URL and SUPABASE_KEY in .env.'
      );
    }
    supabaseClient = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: {
        persistSession: false,
      },
    });
  }
  return supabaseClient;
}

/**
 * Extracts clean name and all assigned roles from user row
 */
export function parseUserRow(data: any): User {
  const telegramId = Number(data.telegram_id);
  const rawName: string = data.name || '';
  const primaryRole: UserRole = data.role as UserRole;

  // Check if rawName contains role tags e.g. "Name [store,sales]" or "Name [sales]"
  const match = rawName.match(/\[([a-zA-Z,\s]+)\]\s*$/);
  let cleanName = rawName;
  const rolesSet = new Set<UserRole>();

  if (primaryRole) {
    rolesSet.add(primaryRole);
  }

  if (match) {
    cleanName = rawName.replace(/\[([a-zA-Z,\s]+)\]\s*$/, '').trim();
    const taggedRoles = match[1]
      .split(',')
      .map((r) => r.trim().toLowerCase()) as UserRole[];
    const validRoles: UserRole[] = ['manager', 'store', 'finance', 'sales'];
    for (const r of taggedRoles) {
      if (validRoles.includes(r)) {
        rolesSet.add(r);
      }
    }
  }

  const roles = Array.from(rolesSet);
  const inMemoryActive = getActiveRole(telegramId);
  const activeRole = inMemoryActive && roles.includes(inMemoryActive) ? inMemoryActive : roles[0] || primaryRole;

  return {
    telegram_id: telegramId,
    name: rawName,
    role: primaryRole,
    roles,
    activeRole,
    cleanName: cleanName || rawName,
    username: data.username || null,
    created_at: data.created_at,
  };
}

export const db = {
  /**
   * Fetch user by telegram_id
   */
  async getUser(telegramId: number): Promise<User | null> {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (error) {
      console.error(`[DB Error] getUser(${telegramId}):`, error.message);
      throw new Error(`Database error while fetching user: ${error.message}`);
    }

    if (!data) return null;

    return parseUserRow(data);
  },

  /**
   * Fetch user by Telegram username
   */
  async getUserByUsername(username: string): Promise<User | null> {
    const cleanUsername = username.replace(/^@/, '').trim().toLowerCase();
    const supabase = getSupabase();
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .ilike('username', cleanUsername)
        .maybeSingle();

      if (error || !data) return null;

      return parseUserRow(data);
    } catch {
      return null;
    }
  },

  /**
   * Upsert a user (create or update their role/name/username)
   */
  async upsertUser(params: {
    telegram_id: number;
    name: string;
    role: UserRole;
    username?: string | null;
  }): Promise<User> {
    const supabase = getSupabase();
    const cleanUsername = params.username ? params.username.replace(/^@/, '').trim() : null;

    // Try upserting with username
    let upsertPayload: any = {
      telegram_id: params.telegram_id,
      name: params.name,
      role: params.role,
    };
    if (cleanUsername) {
      upsertPayload.username = cleanUsername;
    }

    let { data, error } = await supabase
      .from('users')
      .upsert(upsertPayload, { onConflict: 'telegram_id' })
      .select()
      .single();

    // If username column does not exist yet in Postgres, fallback gracefully
    if (error && error.message.includes('username')) {
      const fallback = await supabase
        .from('users')
        .upsert(
          {
            telegram_id: params.telegram_id,
            name: params.name,
            role: params.role,
          },
          { onConflict: 'telegram_id' }
        )
        .select()
        .single();
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      console.error('[DB Error] upsertUser:', error.message);
      throw new Error(`Failed to save user: ${error.message}`);
    }

    return parseUserRow(data);
  },

  /**
   * Get all registered users
   */
  async getAllUsers(): Promise<User[]> {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('role', { ascending: true })
      .order('name', { ascending: true });

    if (error) {
      console.error('[DB Error] getAllUsers:', error.message);
      throw new Error(`Failed to list users: ${error.message}`);
    }

    return (data || []).map((row) => parseUserRow(row));
  },

  /**
   * Delete user by telegram_id
   */
  async deleteUser(telegramId: number): Promise<boolean> {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('telegram_id', telegramId);

    if (error) {
      console.error(`[DB Error] deleteUser(${telegramId}):`, error.message);
      throw new Error(`Failed to delete user: ${error.message}`);
    }

    return true;
  },

  /**
   * Link or update a user's Telegram ID (e.g. from pre-registration placeholder)
   */
  async updateUserTelegramId(
    oldId: number,
    newId: number,
    name: string,
    username?: string | null
  ): Promise<User> {
    const supabase = getSupabase();
    const cleanUsername = username ? username.replace(/^@/, '').trim() : null;

    // Check if user already exists with newId
    const existing = await this.getUser(newId);
    if (existing) {
      const oldUser = await this.getUser(oldId);
      await this.deleteUser(oldId);
      return this.upsertUser({
        telegram_id: newId,
        name: name || existing.name,
        role: oldUser?.role || existing.role,
        username: cleanUsername || existing.username,
      });
    }

    const updatePayload: any = {
      telegram_id: newId,
      name,
    };
    if (cleanUsername) {
      updatePayload.username = cleanUsername;
    }

    const { data, error } = await supabase
      .from('users')
      .update(updatePayload)
      .eq('telegram_id', oldId)
      .select()
      .single();

    if (error) {
      console.error('[DB Error] updateUserTelegramId:', error.message);
      throw new Error(`Failed to update user Telegram ID: ${error.message}`);
    }

    return parseUserRow(data);
  },

  /**
   * Create a new order
   */
  async createOrder(params: {
    sales_id: number;
    client_name: string;
    item_details: string;
    total_amount: number;
    status?: OrderStatus;
  }): Promise<Order> {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('orders')
      .insert({
        sales_id: params.sales_id,
        client_name: params.client_name,
        item_details: params.item_details,
        total_amount: params.total_amount,
        status: params.status || 'pending_approval',
      })
      .select()
      .single();

    if (error) {
      console.error('[DB Error] createOrder:', error.message);
      throw new Error(`Failed to create order: ${error.message}`);
    }

    return {
      id: data.id,
      sales_id: Number(data.sales_id),
      client_name: data.client_name,
      item_details: data.item_details,
      total_amount: Number(data.total_amount),
      status: data.status,
      store_receipt_file_id: data.store_receipt_file_id,
      payment_slip_file_id: data.payment_slip_file_id,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  },

  /**
   * Fetch single order by id
   */
  async getOrder(id: number): Promise<Order | null> {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error(`[DB Error] getOrder(${id}):`, error.message);
      throw new Error(`Failed to fetch order #${id}: ${error.message}`);
    }

    if (!data) return null;

    return {
      id: data.id,
      sales_id: Number(data.sales_id),
      client_name: data.client_name,
      item_details: data.item_details,
      total_amount: Number(data.total_amount),
      status: data.status,
      store_receipt_file_id: data.store_receipt_file_id,
      payment_slip_file_id: data.payment_slip_file_id,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  },

  /**
   * Fetch orders created by sales rep
   */
  async getOrdersBySalesId(salesId: number, limit = 10): Promise<Order[]> {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('sales_id', salesId)
      .order('id', { ascending: false })
      .limit(limit);

    if (error) {
      console.error(`[DB Error] getOrdersBySalesId(${salesId}):`, error.message);
      throw new Error(`Failed to fetch orders for user ${salesId}: ${error.message}`);
    }

    return (data || []).map((row) => ({
      id: row.id,
      sales_id: Number(row.sales_id),
      client_name: row.client_name,
      item_details: row.item_details,
      total_amount: Number(row.total_amount),
      status: row.status,
      store_receipt_file_id: row.store_receipt_file_id,
      payment_slip_file_id: row.payment_slip_file_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  },

  /**
   * Update order status
   */
  async updateOrderStatus(id: number, status: OrderStatus): Promise<Order> {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('orders')
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error(`[DB Error] updateOrderStatus(${id}, ${status}):`, error.message);
      throw new Error(`Failed to update status for order #${id}: ${error.message}`);
    }

    return {
      id: data.id,
      sales_id: Number(data.sales_id),
      client_name: data.client_name,
      item_details: data.item_details,
      total_amount: Number(data.total_amount),
      status: data.status,
      store_receipt_file_id: data.store_receipt_file_id,
      payment_slip_file_id: data.payment_slip_file_id,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  },

  /**
   * Update store receipt file_id and mark as dispatched
   */
  async setStoreReceipt(id: number, fileId: string): Promise<Order> {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('orders')
      .update({
        store_receipt_file_id: fileId,
        status: 'dispatched',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error(`[DB Error] setStoreReceipt(${id}):`, error.message);
      throw new Error(`Failed to save store receipt for order #${id}: ${error.message}`);
    }

    return {
      id: data.id,
      sales_id: Number(data.sales_id),
      client_name: data.client_name,
      item_details: data.item_details,
      total_amount: Number(data.total_amount),
      status: data.status,
      store_receipt_file_id: data.store_receipt_file_id,
      payment_slip_file_id: data.payment_slip_file_id,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  },

  /**
   * Update payment slip file_id and mark as pending_audit
   */
  async setPaymentSlip(id: number, fileId: string): Promise<Order> {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('orders')
      .update({
        payment_slip_file_id: fileId,
        status: 'pending_audit',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error(`[DB Error] setPaymentSlip(${id}):`, error.message);
      throw new Error(`Failed to save payment slip for order #${id}: ${error.message}`);
    }

    return {
      id: data.id,
      sales_id: Number(data.sales_id),
      client_name: data.client_name,
      item_details: data.item_details,
      total_amount: Number(data.total_amount),
      status: data.status,
      store_receipt_file_id: data.store_receipt_file_id,
      payment_slip_file_id: data.payment_slip_file_id,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  },
};

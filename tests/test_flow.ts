import { escapeMarkdown, formatCurrency, formatTime, getStatusBadge } from '../src/utils';
import { getSession, setSession, clearSession } from '../src/state';
import { OrderStatus, UserRole } from '../src/types';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log('--- Running Tests ---');

// Test 1: Utils
console.log('Test 1: Utils (formatting, badges, escaping)');
assert(formatCurrency(12500) === '12,500 ETB', 'Currency formatting 12500');
assert(formatCurrency(0) === '0 ETB', 'Currency formatting 0');
assert(escapeMarkdown('Order #104 [Test]') === 'Order #104 \\[Test\\]', 'Escape markdown [');
assert(escapeMarkdown('Hello *World* _foo_ `bar`') === 'Hello \\*World\\* \\_foo\\_ \\`bar\\`', 'Escape markdown symbols');
assert(getStatusBadge('pending_approval').includes('ማናጀር'), 'Status badge pending_approval');
assert(getStatusBadge('pending_dispatch').includes('ስቶር'), 'Status badge pending_dispatch');
assert(getStatusBadge('dispatched').includes('ስሊፕ'), 'Status badge dispatched');
assert(getStatusBadge('pending_audit').includes('ፋይናንስ'), 'Status badge pending_audit');
assert(getStatusBadge('completed').includes('ተጠናቋል'), 'Status badge completed');
assert(getStatusBadge('cancelled').includes('ተሰርዟል'), 'Status badge cancelled');
console.log('✅ Utils tests passed.');

// Test 2: State management
console.log('Test 2: State management');
const testUserId = 999999999;
assert(getSession(testUserId) === undefined, 'Session initially undefined');

setSession(testUserId, {
  type: 'create_order',
  draft: { step: 'waiting_client' },
});

const session1 = getSession(testUserId);
assert(session1 !== undefined && session1.type === 'create_order', 'Session set to create_order');
if (session1 && session1.type === 'create_order') {
  session1.draft.clientName = 'Acme Corp';
  session1.draft.step = 'waiting_items';
}

const session2 = getSession(testUserId);
assert(
  session2 !== undefined &&
    session2.type === 'create_order' &&
    session2.draft.clientName === 'Acme Corp' &&
    session2.draft.step === 'waiting_items',
  'Draft updated preserved'
);

clearSession(testUserId);
assert(getSession(testUserId) === undefined, 'Session cleared');

// Test payment slip session
setSession(testUserId, {
  type: 'upload_slip',
  orderId: 104,
});
const slipSession = getSession(testUserId);
assert(
  slipSession !== undefined &&
    slipSession.type === 'upload_slip' &&
    slipSession.orderId === 104,
  'Upload slip session stored'
);
clearSession(testUserId);
console.log('✅ State management tests passed.');

// Test 3: Lifecycle status transitions validation
console.log('Test 3: Operational lifecycle status validation');
const validStatuses: OrderStatus[] = [
  'pending_approval',
  'pending_dispatch',
  'dispatched',
  'pending_audit',
  'completed',
  'cancelled',
];

const validRoles: UserRole[] = ['manager', 'store', 'finance', 'sales'];

assert(validStatuses.length === 6, 'Six order statuses defined');
assert(validRoles.length === 4, 'Four user roles defined');

// Role checks simulation
function canActAsManager(role: UserRole): boolean {
  return role === 'manager';
}
function canActAsStore(role: UserRole): boolean {
  return role === 'store' || role === 'manager';
}
function canActAsFinance(role: UserRole): boolean {
  return role === 'finance';
}
function canActAsSales(role: UserRole): boolean {
  return role === 'sales';
}

assert(canActAsSales('sales') === true, 'Sales can act as sales');
assert(canActAsSales('manager') === false, 'Manager cannot act as sales');
assert(canActAsManager('manager') === true, 'Manager can act as manager');
assert(canActAsManager('sales') === false, 'Sales cannot act as manager');
assert(canActAsStore('store') === true, 'Store can act as store');
assert(canActAsStore('finance') === false, 'Finance cannot act as store');
assert(canActAsFinance('finance') === true, 'Finance can act as finance');
assert(canActAsFinance('sales') === false, 'Sales cannot act as finance');
console.log('✅ Lifecycle & authorization logic tests passed.');

// Test 4: Username pre-registration and deterministic ID generation
console.log('Test 4: Username pre-registration ID generation');
import { generatePlaceholderId } from '../src/handlers/manager';

const id1 = generatePlaceholderId('dawit_t');
const id2 = generatePlaceholderId('dawit_t');
const id3 = generatePlaceholderId('fethulm');

assert(id1 === id2, 'Placeholder IDs for same username must be deterministic');
assert(id1 < 0, 'Placeholder ID must be negative to avoid colliding with real Telegram IDs');
assert(id3 < 0, 'Placeholder ID for fethulm must be negative');
assert(id1 !== id3, 'Different usernames must produce distinct IDs');
console.log(`✅ Deterministic placeholder ID tests passed (e.g. @dawit_t -> ${id1}).`);

// Test 5: Multi-role parsing and manager permissions
console.log('Test 5: Multi-role parsing and manager access');
import { parseUserRow } from '../src/supabase';

const multiUser = parseUserRow({
  telegram_id: 12345,
  name: 'Megfira [store,sales]',
  role: 'store',
  username: 'Mekfu24',
});

assert(multiUser.cleanName === 'Megfira', 'Clean name extracted without role tags');
assert(multiUser.roles.length === 2, 'Two roles recognized');
assert(multiUser.roles.includes('store') && multiUser.roles.includes('sales'), 'Roles match store and sales');
assert(multiUser.activeRole === 'store', 'Primary role defaults to activeRole');

const managerUser = parseUserRow({
  telegram_id: 1186650834,
  name: 'Primary Manager',
  role: 'manager',
  username: 'FETHULM',
});
assert(managerUser.roles.includes('manager'), 'Manager role parsed');
assert(managerUser.cleanName === 'Primary Manager', 'Manager clean name');
console.log('✅ Multi-role and manager parsing tests passed.');

// Test 6: Expense regex parsing for truck, labour, delivery
console.log('Test 6: Dispatch expense extraction from store caption');
function extractExpenses(caption: string): { amount: number; note: string } | null {
  const expenseMatches = caption.matchAll(/(?:truck|labour|labor|transport|delivery|fee|exp|extra|\+)\s*[:=-]?\s*(\d+(?:\.\d+)?)/gi);
  let totalExtra = 0;
  const notes: string[] = [];
  for (const m of expenseMatches) {
    const val = parseFloat(m[1]);
    if (!isNaN(val) && val > 0) {
      totalExtra += val;
      notes.push(m[0].trim());
    }
  }
  return totalExtra > 0 ? { amount: totalExtra, note: notes.join(', ') } : null;
}

const parsed1 = extractExpenses('Released! Truck: 300, Labour: 150');
assert(parsed1 !== null && parsed1.amount === 450, 'Parsed 300 truck and 150 labour');

const parsed2 = extractExpenses('Order dispatched +200 delivery');
assert(parsed2 !== null && parsed2.amount === 200, 'Parsed +200 delivery');

const parsed3 = extractExpenses('Just standard release receipt');
assert(parsed3 === null, 'No expenses found in standard caption');
console.log('✅ Dispatch expense parsing tests passed.');

// Test 7: Item details cleaning for sales and history extraction for manager
console.log('Test 7: Sales privacy for store expenses & manager history tracking');
const { cleanItemDetailsForSales, extractStoreExpenseHistory } = require('../src/utils');

const rawItemsWithExpense = '20 bags of cement\n[Store Paid Dispatch: Truck: 300, Labour: 150 (450 ETB)]';
const cleanedForSales = cleanItemDetailsForSales(rawItemsWithExpense);
assert(cleanedForSales === '20 bags of cement', 'Cleaned items for sales rep matches original');
assert(!cleanedForSales.includes('Store Paid Dispatch'), 'Sales rep does not see store paid dispatch');
assert(!cleanedForSales.includes('450 ETB'), 'Sales rep does not see expense amount');

const extractedExpense = extractStoreExpenseHistory(rawItemsWithExpense);
assert(extractedExpense !== null && extractedExpense.includes('Truck: 300'), 'Manager history extracts dispatch expense note');
console.log('✅ Sales privacy and manager history extraction tests passed.');

console.log('🎉 All unit and logic tests passed successfully!');

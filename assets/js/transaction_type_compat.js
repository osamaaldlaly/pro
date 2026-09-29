/**
 * Transaction Type Compatibility Layer
 *
 * Purpose:
 *   Centralizes the accounting nature of a transaction.
 *   The raw `type` field on a Transaction object can now carry either:
 *     - Legacy values  : 'credit' | 'debit'
 *     - Source labels  : 'عملية بيع' | 'عملية شراء'
 *   This layer maps every known alias to a canonical accounting polarity
 *   so that the rest of the application never needs to enumerate aliases.
 *
 * Extension rule:
 *   To support a new transaction source or label, only add it here.
 *   Nothing else in the codebase needs to change.
 *
 * NOTE: This file NEVER modifies stored data. It is a read-only lens.
 */

// ---------------------------------------------------------------------------
// Canonical sets
// ---------------------------------------------------------------------------

/** All type values that represent a CREDIT (عليه — money owed TO us). */
const CREDIT_TYPES = new Set([
    'credit',
    'عملية بيع',   // created by CustomerInvoiceService
]);

/** All type values that represent a DEBIT (له — money owed BY us). */
const DEBIT_TYPES = new Set([
    'debit',
    'عملية شراء',  // created by PurchaseCustomerService
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when the transaction is a CREDIT operation.
 * (Customer owes us money — "عليه")
 *
 * @param {object} transaction – any object with a `type` property
 * @returns {boolean}
 */
function isCreditTransaction(transaction) {
    return CREDIT_TYPES.has(transaction && transaction.type);
}

/**
 * Returns true when the transaction is a DEBIT operation.
 * (We owe the customer money — "له")
 *
 * @param {object} transaction – any object with a `type` property
 * @returns {boolean}
 */
function isDebitTransaction(transaction) {
    return DEBIT_TYPES.has(transaction && transaction.type);
}

// ---------------------------------------------------------------------------
// Global exposure (usable as window.isCreditTransaction / window.isDebitTransaction)
// ---------------------------------------------------------------------------
window.isCreditTransaction = isCreditTransaction;
window.isDebitTransaction   = isDebitTransaction;

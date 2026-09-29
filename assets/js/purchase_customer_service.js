/**
 * Purchase Customer Integration Service
 * Responsible for managing the lifecycle of Customer Ledger projections linked to Purchase Records.
 *
 * Architectural contract:
 *   - Purchase Record is the Single Source of Truth.
 *   - Customer Ledger stores projections only.
 *   - This service NEVER modifies PurchaseService, StockService, or InventoryService.
 *   - This service NEVER touches manual customer transactions.
 *   - Generated transactions carry referenceType = 'purchase' and source = 'purchase'.
 */
class PurchaseCustomerService {

    // 1. Find the customer ledger projection linked to a specific purchase
    static findTransactionForPurchase(transactions, purchaseId) {
        if (!purchaseId) return null;
        return transactions.find(
            t => t.referenceType === 'purchase' && t.referenceId === purchaseId
        ) || null;
    }

    // 2. Check if a projection linked to the purchase already exists
    static hasTransactionForPurchase(transactions, purchaseId) {
        return !!this.findTransactionForPurchase(transactions, purchaseId);
    }

    // 3. Build the projection transaction object
    //    type: 'debit' = "له" (we owe the supplier/customer)
    static createTransactionObject(purchase, customerId, existingId = null) {
        const totalAmount = (Number(purchase.costPrice) || 0) * (Number(purchase.quantity) || 0);
        return {
            id: existingId || ('tx_pur_' + purchase.id),
            customerId: customerId,
            referenceType: 'purchase',
            referenceId: purchase.id,
            purchaseId: purchase.id,
            source: 'purchase',
            type: 'debit', // "له" — we owe the supplier/customer
            amount: totalAmount,
            currency: 'YER',
            paymentMethod: 'اّجل',
            bankId: 'none',
            bankCustomName: '',
            note: 'فاتورة شراء',
            date: purchase.createdAt || new Date().toISOString()
        };
    }

    // 4. Synchronize a Purchase Record with the Customer Ledger
    //    options.delete = true  → remove the projection
    //    otherwise             → create or update the projection
    static sync(purchase, options = {}) {
        if (!purchase || !purchase.id) return;

        if (typeof window.ReactApp === 'undefined' || !window.ReactApp.setData) return;

        const customerId = purchase.customerId;

        // If no customer is bound, and this is not a deletion, nothing to do
        if (!options.delete && !customerId) return;

        window.ReactApp.setData(prev => {
            let transactions = prev.transactions || [];

            // Always remove the existing projection first (handles delete + update cleanly)
            transactions = transactions.filter(
                t => !(t.referenceType === 'purchase' && t.referenceId === purchase.id)
            );

            // If this is a deletion, stop here — only the generated projection is removed
            if (options.delete) {
                return { ...prev, transactions };
            }

            // Build and prepend the updated projection
            const txData = this.createTransactionObject(purchase, customerId);
            transactions = [txData, ...transactions];

            if (typeof window.updateLocalStat === 'function') {
                window.updateLocalStat('customer_tx', 1);
            }

            return { ...prev, transactions };
        });
    }
}

window.PurchaseCustomerService = PurchaseCustomerService;

/**
 * Customer Invoice Integration Service
 * Responsible for managing the lifecycle of customer transactions linked to invoices.
 */
class CustomerInvoiceService {
    // 1. Search for customer by name in the database
    static findCustomerByName(customers, name) {
        if (!name) return null;
        const normalized = name.trim();
        return customers.find(c => c.name.trim() === normalized) || null;
    }

    // 2. Find customer transaction linked to a specific invoice
    static findTransactionForInvoice(transactions, invoiceId) {
        if (!invoiceId) return null;
        return transactions.find(t => t.referenceType === 'invoice' && t.referenceId === invoiceId) || null;
    }

    // 3. Check if a transaction linked to the invoice exists
    static hasTransactionForInvoice(transactions, invoiceId) {
        return !!this.findTransactionForInvoice(transactions, invoiceId);
    }

    // 4. Create customer transaction object
    static createTransactionObject(invoice, customerId, existingId = null) {
        const invoiceAmount = (invoice.items || []).reduce((sum, item) => sum + (parseFloat(item.price) * parseFloat(item.qty)), 0);
        return {
            id: existingId || ('tx_inv_' + invoice.id),
            customerId: customerId,
            referenceType: 'invoice',
            referenceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            amount: invoiceAmount,
            currency: invoice.currency || 'YER',
            type: 'عملية بيع', // 'credit' is the database key for 'عليه' (customer owes us money)
            date: invoice.date || invoice.createdAt || new Date().toISOString(),
            paymentMethod: invoice.paymentMethod || 'اّجل',
            bankId: invoice.paymentMethod === 'bank' ? invoice.bankDetails?.id || 'none' : 'none',
            bankCustomName: invoice.paymentMethod === 'bank' && invoice.bankDetails?.id === 'custom' ? (invoice.bankDetails?.customName || '').trim() : '',
            note: invoice.creditNote || ('فاتورة مبيعات رقم ' + invoice.invoiceNumber)
        };
    }

    // 5. Synchronize invoice with customer transactions
    static sync(invoice, options = {}) {
        if (!invoice || !invoice.id) return;

        if (typeof window.ReactApp !== 'undefined' && window.ReactApp.setData) {
            window.ReactApp.setData(prev => {
                const customers = prev.customers || [];
                let transactions = prev.transactions || [];
                let invoices = prev.invoices || [];

                // 1. Delete associated transaction if option is set
                if (options.delete) {
                    transactions = transactions.filter(t => !(t.referenceType === 'invoice' && t.referenceId === invoice.id));
                    return {
                        ...prev,
                        transactions
                    };
                }

                // 2. Lookup customer in the database by name
                const customer = this.findCustomerByName(customers, invoice.customer?.name);

                if (customer) {
                    // Update/set customerId inside the invoice
                    invoice.customerId = customer.id;

                    // Update invoice inside the state invoices array
                    invoices = invoices.map(inv => {
                        if (inv.id === invoice.id) {
                            const updatedInv = { ...inv };
                            updatedInv.customerId = customer.id;
                            return updatedInv;
                        }
                        return inv;
                    });

                    // Search for existing transaction
                    const existingTx = this.findTransactionForInvoice(transactions, invoice.id);
                    const txData = this.createTransactionObject(invoice, customer.id, existingTx ? existingTx.id : null);

                    if (existingTx) {
                        // Update transaction
                        transactions = transactions.map(t => t.id === existingTx.id ? txData : t);
                    } else {
                        // Create transaction
                        transactions = [txData, ...transactions];
                        if (typeof window.updateLocalStat === 'function') {
                            window.updateLocalStat('customer_tx', 1);
                        }
                    }
                } else {
                    // If customer does not exist, remove customerId completely
                    delete invoice.customerId;

                    // Update invoice inside the state invoices array
                    invoices = invoices.map(inv => {
                        if (inv.id === invoice.id) {
                            const updatedInv = { ...inv };
                            delete updatedInv.customerId;
                            return updatedInv;
                        }
                        return inv;
                    });

                    // Remove any customer transaction previously linked to this invoice
                    transactions = transactions.filter(t => !(t.referenceType === 'invoice' && t.referenceId === invoice.id));
                }

                return {
                    ...prev,
                    transactions,
                    invoices
                };
            });
        }
    }
}

window.CustomerInvoiceService = CustomerInvoiceService;

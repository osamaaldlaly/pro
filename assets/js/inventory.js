/**
 * Hsabaty Inventory System - Phase 1 (Architecture Foundation)
 * Models & Services for offline-first inventory management.
 */

// ==========================================
// 1. Data Models
// ==========================================

/**
 * Product Model
 */
class Product {
    constructor(data = {}) {
        this.id = data.id || '';
        this.name = data.name || '';
        this.barcode = data.barcode || '';
        this.internalCode = data.internalCode || '';
        this.categoryId = data.categoryId || '';
        this.openingQuantity = Number(data.openingQuantity) || 0;
        this.currentQuantity = Number(data.currentQuantity) || 0;
        this.costPrice = Number(data.costPrice) || 0;
        this.salePrice = Number(data.salePrice) || 0;
        this.baseUnit = data.baseUnit || '';
        this.displayUnit = data.displayUnit || '';
        this.unitFactor = Number(data.unitFactor) || 1;
        this.minimumQuantity = Number(data.minimumQuantity) || 0;
        this.createdAt = data.createdAt || new Date().toISOString();
        this.updatedAt = data.updatedAt || new Date().toISOString();
        this.active = data.active !== undefined ? !!data.active : true;
    }
}

/**
 * Category Model
 */
class Category {
    constructor(data = {}) {
        this.id = data.id || '';
        this.name = data.name || '';
        this.createdAt = data.createdAt || new Date().toISOString();
    }
}

/**
 * Purchase Model
 */
class Purchase {
    constructor(data = {}) {
        this.id = data.id || '';
        this.productId = data.productId || '';
        this.quantity = Number(data.quantity) || 0;
        this.costPrice = Number(data.costPrice) || 0;
        this.salePrice = Number(data.salePrice) || 0;
        this.supplier = data.supplier || '';
        this.customerId = data.customerId || '';
        this.createdAt = data.createdAt || new Date().toISOString();
    }
}

/**
 * StockMovement Model
 */
class StockMovement {
    constructor(data = {}) {
        this.id = data.id || '';
        this.productId = data.productId || '';
        this.type = data.type || ''; // PURCHASE, SALE, MANUAL, STOCKTAKE
        this.quantity = Number(data.quantity) || 0;
        this.balanceBefore = Number(data.balanceBefore) || 0;
        this.balanceAfter = Number(data.balanceAfter) || 0;
        this.invoiceId = data.invoiceId || '';
        this.referenceId = data.referenceId || '';
        this.stocktakeId = data.stocktakeId || '';
        this.adjustmentType = data.adjustmentType || '';
        this.lossValue = Number(data.lossValue) || 0;
        this.note = data.note || '';
        this.createdAt = data.createdAt || new Date().toISOString();
    }
}

class Stocktake {
    constructor(data = {}) {
        this.id = data.id || '';
        this.number = Number(data.number) || 0;
        this.status = data.status || 'DRAFT';
        this.createdAt = data.createdAt || new Date().toISOString();
        this.updatedAt = data.updatedAt || this.createdAt;
        this.completedAt = data.completedAt || '';
        this.itemCount = Number(data.itemCount) || 0;
        this.categoryCount = Number(data.categoryCount) || 0;
        this.previousStocktakeId = data.previousStocktakeId || '';
        this.hiddenFromList = data.hiddenFromList === true;
        this.notes = data.notes || '';
    }
}

class StocktakeItem {
    constructor(data = {}) {
        this.id = data.id || '';
        this.stocktakeId = data.stocktakeId || '';
        this.productId = data.productId || '';
        this.productName = data.productName || '';
        this.productCode = data.productCode || '';
        this.categoryId = data.categoryId || '';
        this.categoryName = data.categoryName || '';
        this.expectedQuantity = Number(data.expectedQuantity) || 0;
        this.actualQuantity = data.actualQuantity === '' || data.actualQuantity === null || data.actualQuantity === undefined ? null : Number(data.actualQuantity);
        this.difference = Number(data.difference) || 0;
        this.costPrice = Number(data.costPrice) || 0;
        this.adjustmentType = data.adjustmentType || '';
        this.status = data.status || 'PENDING';
        this.lossValue = Number(data.lossValue) || 0;
        this.movementId = data.movementId || '';
        this.createdAt = data.createdAt || new Date().toISOString();
        this.updatedAt = data.updatedAt || this.createdAt;
    }
}

// ==========================================
// 2. Services
// ==========================================

/**
 * Inventory Storage Service
 */
class InventoryService {
    static STORAGE_KEY = 'hsabaty_inventory_data';

    /**
     * Loads the raw inventory data structure from localStorage.
     */
    static loadData() {
        try {
            const raw = (typeof AppStorage !== 'undefined')
                ? AppStorage.getItem(this.STORAGE_KEY)
                : localStorage.getItem(this.STORAGE_KEY);
            if (!raw) {
                return this.getEmptyData();
            }
            const data = JSON.parse(raw);
            return {
                products: Array.isArray(data.products) ? data.products : [],
                categories: Array.isArray(data.categories) ? data.categories : [],
                purchases: Array.isArray(data.purchases) ? data.purchases : [],
                stockMovements: Array.isArray(data.stockMovements) ? data.stockMovements : [],
                stocktakes: Array.isArray(data.stocktakes) ? data.stocktakes : [],
                stocktakeItems: Array.isArray(data.stocktakeItems) ? data.stocktakeItems : []
            };
        } catch (e) {
            console.error("Failed to load inventory data:", e);
            return this.getEmptyData();
        }
    }

    /**
     * Saves the inventory data structure to localStorage.
     */
    static saveData(data) {
        try {
            if (typeof AppStorage !== 'undefined') {
                const result = AppStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
                if (result && typeof result.catch === 'function') {
                    result.catch(e => console.error("Failed to save inventory data:", e));
                }
            } else {
                localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
            }
            this.notifyDataChanged();
            return true;
        } catch (e) {
            console.error("Failed to save inventory data:", e);
            return false;
        }
    }

    static notifyDataChanged() {
        try {
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                window.dispatchEvent(new CustomEvent('inventory:data-changed'));
            }
        } catch (e) { }
    }

    /**
     * Returns a blank skeleton of the database.
     */
    static getEmptyData() {
        return {
            products: [],
            categories: [],
            purchases: [],
            stockMovements: [],
            stocktakes: [],
            stocktakeItems: []
        };
    }

    /**
     * Clears all data inside the inventory storage key.
     */
    static clearAllData() {
        return this.saveData(this.getEmptyData());
    }
}

/**
 * Category CRUD Service
 */
class CategoryService {
    static getAll() {
        const data = InventoryService.loadData();
        return data.categories.map(c => new Category(c));
    }

    static getById(id) {
        const categories = this.getAll();
        return categories.find(c => c.id === id) || null;
    }

    static create(categoryData) {
        const data = InventoryService.loadData();

        if (!categoryData.name || !categoryData.name.trim()) {
            throw new Error("Category name is required");
        }

        const id = 'cat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const newCategory = new Category({
            id: id,
            name: categoryData.name.trim(),
            createdAt: new Date().toISOString()
        });

        data.categories.push(newCategory);
        InventoryService.saveData(data);
        return newCategory;
    }

    static update(id, categoryData) {
        const data = InventoryService.loadData();
        const index = data.categories.findIndex(c => c.id === id);
        if (index === -1) {
            throw new Error(`Category with ID ${id} not found`);
        }

        if (!categoryData.name || !categoryData.name.trim()) {
            throw new Error("Category name is required");
        }

        const updatedCategory = new Category({
            ...data.categories[index],
            name: categoryData.name.trim()
        });

        data.categories[index] = updatedCategory;
        InventoryService.saveData(data);
        return updatedCategory;
    }

    static delete(id, options = {}) {
        const data = InventoryService.loadData();
        const index = data.categories.findIndex(c => c.id === id);
        if (index === -1) {
            throw new Error(`Category with ID ${id} not found`);
        }

        const cascadeProducts = options === true || options.cascadeProducts === true;
        const categoryProductIds = new Set((data.products || [])
            .filter(p => p.categoryId === id)
            .map(p => p.id));

        if (cascadeProducts && categoryProductIds.size > 0) {
            data.products = data.products.filter(p => !categoryProductIds.has(p.id));
            data.purchases = (data.purchases || []).filter(pur => !categoryProductIds.has(pur.productId));
            data.stockMovements = (data.stockMovements || []).filter(m => !categoryProductIds.has(m.productId));
            data.stocktakeItems = (data.stocktakeItems || []).filter(item => !categoryProductIds.has(item.productId));
        } else {
            // Keep backward compatibility for callers that only remove the category.
            data.products = data.products.map(p => {
                if (p.categoryId === id) {
                    return { ...p, categoryId: '', updatedAt: new Date().toISOString() };
                }
                return p;
            });
        }

        data.categories.splice(index, 1);
        InventoryService.saveData(data);
        return true;
    }
}

/**
 * Product CRUD Service
 */
class ProductService {
    static getAll() {
        const data = InventoryService.loadData();
        return data.products.map(p => new Product(p));
    }

    static getById(id) {
        const products = this.getAll();
        return products.find(p => p.id === id) || null;
    }

    static getByCategory(categoryId) {
        const products = this.getAll();
        return products.filter(p => p.categoryId === categoryId);
    }

    static create(productData) {
        const data = InventoryService.loadData();

        if (!productData.name || !productData.name.trim()) {
            throw new Error("Product name is required");
        }

        const id = 'prod_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const openingQty = Number(productData.openingQuantity) || 0;

        const newProduct = new Product({
            id: id,
            name: productData.name.trim(),
            barcode: productData.barcode || '',
            internalCode: productData.internalCode || '',
            categoryId: productData.categoryId || '',
            openingQuantity: openingQty,
            currentQuantity: openingQty,
            costPrice: Number(productData.costPrice) || 0,
            salePrice: Number(productData.salePrice) || 0,
            baseUnit: productData.baseUnit || '',
            displayUnit: productData.displayUnit || '',
            unitFactor: Number(productData.unitFactor) || 1,
            minimumQuantity: Number(productData.minimumQuantity) || 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            active: productData.active !== undefined ? !!productData.active : true
        });

        data.products.push(newProduct);
        if (openingQty > 0) {
            data.stockMovements.push(new StockMovement({
                id: 'mov_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                productId: id,
                type: 'MANUAL',
                quantity: openingQty,
                balanceBefore: 0,
                balanceAfter: openingQty,
                referenceId: 'initial_stock',
                createdAt: new Date().toISOString()
            }));
        }
        InventoryService.saveData(data);

        return newProduct;
    }

    static update(id, productData) {
        const data = InventoryService.loadData();
        const index = data.products.findIndex(p => p.id === id);
        if (index === -1) {
            throw new Error(`Product with ID ${id} not found`);
        }

        if (!productData.name || !productData.name.trim()) {
            throw new Error("Product name is required");
        }

        const currentProd = data.products[index];
        const updatedProduct = new Product({
            ...currentProd,
            name: productData.name.trim(),
            barcode: productData.barcode !== undefined ? productData.barcode : currentProd.barcode,
            internalCode: productData.internalCode !== undefined ? productData.internalCode : currentProd.internalCode,
            categoryId: productData.categoryId !== undefined ? productData.categoryId : currentProd.categoryId,
            costPrice: productData.costPrice !== undefined ? Number(productData.costPrice) : currentProd.costPrice,
            salePrice: productData.salePrice !== undefined ? Number(productData.salePrice) : currentProd.salePrice,
            baseUnit: productData.baseUnit !== undefined ? productData.baseUnit : currentProd.baseUnit,
            displayUnit: productData.displayUnit !== undefined ? productData.displayUnit : currentProd.displayUnit,
            unitFactor: productData.unitFactor !== undefined ? Number(productData.unitFactor) : currentProd.unitFactor,
            minimumQuantity: productData.minimumQuantity !== undefined ? Number(productData.minimumQuantity) : currentProd.minimumQuantity,
            active: productData.active !== undefined ? !!productData.active : currentProd.active,
            updatedAt: new Date().toISOString()
        });

        data.products[index] = updatedProduct;
        InventoryService.saveData(data);
        return updatedProduct;
    }

    static delete(id) {
        const data = InventoryService.loadData();
        const index = data.products.findIndex(p => p.id === id);
        if (index === -1) {
            throw new Error(`Product with ID ${id} not found`);
        }

        // Delete the product
        data.products.splice(index, 1);

        // Cascade delete associated purchases and movements
        data.purchases = data.purchases.filter(pur => pur.productId !== id);
        data.stockMovements = data.stockMovements.filter(m => m.productId !== id);
        data.stocktakeItems = (data.stocktakeItems || []).filter(item => item.productId !== id);

        InventoryService.saveData(data);
        return true;
    }
}

/**
 * Stock Movements and Adjustments Service
 */
class StockService {
    static getAllMovements() {
        const data = InventoryService.loadData();
        return data.stockMovements.map(m => new StockMovement(m));
    }

    static getMovementsByProduct(productId) {
        const movements = this.getAllMovements();
        return movements.filter(m => m.productId === productId);
    }

    /**
     * Records a stock movement and updates the product's currentQuantity.
     */
    static recordMovement(productId, type, quantity, referenceId = '') {
        const data = InventoryService.loadData();

        const productIndex = data.products.findIndex(p => p.id === productId);
        if (productIndex === -1) {
            throw new Error(`Product with ID ${productId} not found`);
        }

        const product = data.products[productIndex];
        const balanceBefore = product.currentQuantity;
        const balanceAfter = balanceBefore + quantity;

        const movementId = 'mov_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const newMovement = new StockMovement({
            id: movementId,
            productId: productId,
            type: type,
            quantity: quantity,
            balanceBefore: balanceBefore,
            balanceAfter: balanceAfter,
            referenceId: referenceId,
            createdAt: new Date().toISOString()
        });

        // Update product state
        product.currentQuantity = balanceAfter;
        product.updatedAt = new Date().toISOString();

        data.stockMovements.push(newMovement);
        InventoryService.saveData(data);

        return newMovement;
    }

    /**
     * Manually adjusts the stock of a product to a new target quantity.
     */
    static adjustStock(productId, newQuantity, reason = '') {
        const data = InventoryService.loadData();
        const productIndex = data.products.findIndex(p => p.id === productId);
        if (productIndex === -1) {
            throw new Error(`Product with ID ${productId} not found`);
        }

        const product = data.products[productIndex];
        const diff = newQuantity - product.currentQuantity;
        if (diff === 0) {
            return null; // No difference, do nothing
        }

        return this.recordMovement(productId, 'MANUAL', diff, reason);
    }

    static recordStocktakeMovement(data, productId, quantity, stocktakeId, itemId, adjustmentType, lossValue = 0) {
        const productIndex = data.products.findIndex(p => p.id === productId);
        if (productIndex === -1) {
            throw new Error(`Product with ID ${productId} not found`);
        }

        const product = data.products[productIndex];
        const balanceBefore = Number(product.currentQuantity) || 0;
        const balanceAfter = balanceBefore + (Number(quantity) || 0);
        const movementId = 'mov_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const movement = new StockMovement({
            id: movementId,
            productId,
            type: 'STOCKTAKE',
            quantity: Number(quantity) || 0,
            balanceBefore,
            balanceAfter,
            referenceId: itemId || stocktakeId,
            stocktakeId,
            adjustmentType,
            lossValue,
            note: `عملية تسوية جرد - ${StocktakeService.getAdjustmentLabel(adjustmentType)}`,
            createdAt: new Date().toISOString()
        });

        product.currentQuantity = balanceAfter;
        product.updatedAt = new Date().toISOString();
        data.stockMovements.push(movement);
        return movement;
    }
}

class StocktakeService {
    static getAdjustmentLabel(type) {
        if (type === 'INPUT_ERROR') return 'تصحيح خطأ';
        if (type === 'DAMAGED') return 'تالف';
        if (type === 'MISSING') return 'مفقود';
        return 'تسوية';
    }

    static getAll() {
        const data = InventoryService.loadData();
        return (data.stocktakes || [])
            .filter(s => s.hiddenFromList !== true)
            .map(s => new Stocktake(s))
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    }

    static getById(id) {
        return this.getAll().find(s => s.id === id) || null;
    }

    static getItems(stocktakeId) {
        const data = InventoryService.loadData();
        return (data.stocktakeItems || [])
            .filter(item => item.stocktakeId === stocktakeId)
            .map(item => new StocktakeItem(item));
    }

    static getLatestDraft(data = null) {
        const stocktakes = data ? (data.stocktakes || []).map(s => new Stocktake(s)) : this.getAll();
        return stocktakes.find(s => s.status === 'DRAFT') || null;
    }

    static canEdit(stocktakeId, data = null) {
        const latestDraft = this.getLatestDraft(data);
        return !!latestDraft && latestDraft.id === stocktakeId;
    }

    static create() {
        const data = InventoryService.loadData();
        const existingDraft = (data.stocktakes || [])
            .filter(s => s.status === 'DRAFT')
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
        if (existingDraft) return new Stocktake(existingDraft);

        const now = new Date().toISOString();
        const completed = (data.stocktakes || [])
            .filter(s => s.status === 'COMPLETED')
            .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0));
        const number = (data.stocktakes || []).reduce((max, s) => Math.max(max, Number(s.number) || 0), 0) + 1;
        const id = 'stk_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const categoriesById = new Map((data.categories || []).map(c => [c.id, c]));
        const activeProducts = (data.products || []).filter(p => p.active !== false);
        const categoryIds = new Set(activeProducts.map(p => p.categoryId || 'uncategorized'));
        const stocktake = new Stocktake({
            id,
            number,
            status: 'DRAFT',
            createdAt: now,
            updatedAt: now,
            itemCount: activeProducts.length,
            categoryCount: categoryIds.size,
            previousStocktakeId: completed[0]?.id || ''
        });
        const items = activeProducts.map(product => {
            const cat = categoriesById.get(product.categoryId);
            return new StocktakeItem({
                id: 'stki_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                stocktakeId: id,
                productId: product.id,
                productName: product.name,
                productCode: product.internalCode || product.barcode || '',
                categoryId: product.categoryId || '',
                categoryName: cat ? cat.name : 'بدون فئة',
                expectedQuantity: Number(product.currentQuantity) || 0,
                costPrice: Number(product.costPrice) || 0,
                status: 'PENDING',
                createdAt: now,
                updatedAt: now
            });
        });

        data.stocktakes.push(stocktake);
        data.stocktakeItems.push(...items);
        InventoryService.saveData(data);
        return stocktake;
    }

    static markMatched(stocktakeId, productId) {
        const data = InventoryService.loadData();
        const stocktake = data.stocktakes.find(s => s.id === stocktakeId);
        if (!stocktake || stocktake.status !== 'DRAFT' || !this.canEdit(stocktakeId)) {
            throw new Error('لا يمكن تعديل هذا الجرد');
        }
        const item = data.stocktakeItems.find(i => i.stocktakeId === stocktakeId && i.productId === productId);
        if (!item) throw new Error('لم يتم العثور على الصنف داخل الجرد');

        item.actualQuantity = Number(item.expectedQuantity) || 0;
        item.difference = 0;
        item.adjustmentType = '';
        item.lossValue = 0;
        item.movementId = '';
        item.status = 'MATCHED';
        item.updatedAt = new Date().toISOString();
        stocktake.updatedAt = item.updatedAt;
        InventoryService.saveData(data);
        return new StocktakeItem(item);
    }

    static adjustItem(stocktakeId, productId, actualQuantity, adjustmentType) {
        const data = InventoryService.loadData();
        const stocktake = data.stocktakes.find(s => s.id === stocktakeId);
        if (!stocktake || stocktake.status !== 'DRAFT' || !this.canEdit(stocktakeId)) {
            throw new Error('لا يمكن تعديل هذا الجرد');
        }
        if (!['INPUT_ERROR', 'DAMAGED', 'MISSING'].includes(adjustmentType)) {
            throw new Error('نوع التسوية غير صحيح');
        }
        const item = data.stocktakeItems.find(i => i.stocktakeId === stocktakeId && i.productId === productId);
        if (!item) throw new Error('لم يتم العثور على الصنف داخل الجرد');
        const product = data.products.find(p => p.id === productId);
        if (!product) throw new Error('الصنف لم يعد موجوداً');

        const actual = Number(actualQuantity);
        if (!Number.isFinite(actual)) throw new Error('الكمية الفعلية غير صحيحة');
        const expected = Number(product.currentQuantity) || 0;
        const diff = actual - expected;
        const lossValue = (adjustmentType === 'DAMAGED' || adjustmentType === 'MISSING') && diff < 0
            ? Math.abs(diff) * (Number(product.costPrice) || Number(item.costPrice) || 0)
            : 0;

        item.expectedQuantity = expected;
        item.actualQuantity = actual;
        item.difference = diff;
        item.costPrice = Number(product.costPrice) || Number(item.costPrice) || 0;
        item.adjustmentType = adjustmentType;
        item.lossValue = lossValue;
        item.movementId = '';
        item.status = 'ADJUSTED';
        item.updatedAt = new Date().toISOString();
        stocktake.updatedAt = item.updatedAt;
        InventoryService.saveData(data);
        return new StocktakeItem(item);
    }

    static saveDraft(stocktakeId) {
        const data = InventoryService.loadData();
        const stocktake = data.stocktakes.find(s => s.id === stocktakeId);
        if (!stocktake || stocktake.status !== 'DRAFT') throw new Error('لا يمكن حفظ هذا الجرد كمسودة');
        stocktake.updatedAt = new Date().toISOString();
        InventoryService.saveData(data);
        return new Stocktake(stocktake);
    }

    static deleteDraft(stocktakeId) {
        const data = InventoryService.loadData();
        const stocktake = data.stocktakes.find(s => s.id === stocktakeId);
        if (!stocktake || stocktake.status !== 'DRAFT' || !this.canEdit(stocktakeId)) {
            throw new Error('لا يمكن حذف هذا الجرد');
        }
        data.stocktakes = data.stocktakes.filter(s => s.id !== stocktakeId);
        data.stocktakeItems = (data.stocktakeItems || []).filter(item => item.stocktakeId !== stocktakeId);
        InventoryService.saveData(data);
        return true;
    }

    static hideFromList(stocktakeId) {
        const data = InventoryService.loadData();
        const stocktake = data.stocktakes.find(s => s.id === stocktakeId);
        if (!stocktake) throw new Error('لم يتم العثور على الجرد');
        if (stocktake.status === 'DRAFT') {
            return this.deleteDraft(stocktakeId);
        }
        stocktake.hiddenFromList = true;
        stocktake.updatedAt = new Date().toISOString();
        InventoryService.saveData(data);
        return true;
    }

    static complete(stocktakeId, financialData = null) {
        const data = InventoryService.loadData();
        const stocktake = data.stocktakes.find(s => s.id === stocktakeId);
        if (!stocktake || stocktake.status !== 'DRAFT' || !this.canEdit(stocktakeId, data)) {
            throw new Error('لا يمكن اعتماد هذا الجرد');
        }
        const items = (data.stocktakeItems || []).filter(item => item.stocktakeId === stocktakeId);
        const now = new Date().toISOString();
        const generatedExpenses = [];
        const inventorySnapshot = JSON.stringify(data);

        items.filter(item => item.status === 'ADJUSTED').forEach(item => {
            const product = data.products.find(p => p.id === item.productId);
            if (!product) return;
            const expectedAtApproval = Number(product.currentQuantity) || 0;
            const actualAtApproval = Number(item.actualQuantity) || 0;
            const diff = actualAtApproval - expectedAtApproval;
            item.expectedQuantity = expectedAtApproval;
            item.difference = diff;
            item.costPrice = Number(product.costPrice) || Number(item.costPrice) || 0;
            item.lossValue = (item.adjustmentType === 'DAMAGED' || item.adjustmentType === 'MISSING') && diff < 0
                ? Math.abs(diff) * (Number(item.costPrice) || 0)
                : 0;
            let movement = null;
            if (diff !== 0) {
                movement = StockService.recordStocktakeMovement(
                    data,
                    item.productId,
                    diff,
                    stocktakeId,
                    item.id,
                    item.adjustmentType,
                    Number(item.lossValue) || 0
                );
                item.movementId = movement.id;
            }
            if ((item.adjustmentType === 'DAMAGED' || item.adjustmentType === 'MISSING') && Number(item.lossValue) > 0) {
                generatedExpenses.push({
                    id: `exp_stocktake_${stocktakeId}_${item.id}`,
                    amount: Number(item.lossValue) || 0,
                    currency: 'YER',
                    category: 'inventory_loss',
                    note: `${item.adjustmentType === 'DAMAGED' ? 'نفقة تالف' : 'نفقة مفقود'} - ${item.productName} - جرد رقم ${stocktake.number || stocktake.id}`,
                    date: now,
                    createdAt: now,
                    paymentMethod: 'cash',
                    bankId: 'none',
                    bankCustomName: '',
                    referenceType: 'stocktake',
                    referenceId: stocktakeId,
                    stocktakeItemId: item.id
                });
            }
            item.updatedAt = now;
        });

        stocktake.status = 'COMPLETED';
        stocktake.completedAt = now;
        stocktake.updatedAt = now;

        const inventorySaved = InventoryService.saveData(data);
        if (!inventorySaved) throw new Error('فشل حفظ بيانات الجرد');

        let normalizedFinancialData = null;
        if (financialData && generatedExpenses.length > 0) {
            const previousFinancialRaw = (typeof AppStorage !== 'undefined')
                ? AppStorage.getItem('hisabati_v6_data')
                : localStorage.getItem('hisabati_v6_data');
            try {
                normalizedFinancialData = {
                    ...financialData,
                    expenses: [
                        ...generatedExpenses,
                        ...(Array.isArray(financialData.expenses) ? financialData.expenses.filter(exp => !generatedExpenses.some(g => g.id === exp.id)) : [])
                    ]
                };
                const payload = JSON.stringify(normalizedFinancialData);
                if (typeof AppStorage !== 'undefined') {
                    AppStorage.setItem('hisabati_v6_data', payload);
                } else {
                    localStorage.setItem('hisabati_v6_data', payload);
                }
            } catch (err) {
                InventoryService.saveData(JSON.parse(inventorySnapshot));
                if (previousFinancialRaw) {
                    if (typeof AppStorage !== 'undefined') AppStorage.setItem('hisabati_v6_data', previousFinancialRaw);
                    else localStorage.setItem('hisabati_v6_data', previousFinancialRaw);
                }
                throw err;
            }
        }

        return { stocktake: new Stocktake(stocktake), expenses: generatedExpenses, financialData: normalizedFinancialData };
    }

    static getSummary(stocktakeId) {
        const stocktake = this.getById(stocktakeId);
        const items = this.getItems(stocktakeId);
        return this.buildSummary(stocktake, items);
    }

    static buildSummary(stocktake, items) {
        const rows = Array.isArray(items) ? items : [];
        const adjusted = rows.filter(i => i.status === 'ADJUSTED');
        const matched = rows.filter(i => i.status === 'MATCHED');
        const increase = adjusted.reduce((sum, i) => sum + Math.max(0, Number(i.difference) || 0), 0);
        const decrease = adjusted.reduce((sum, i) => sum + Math.abs(Math.min(0, Number(i.difference) || 0)), 0);
        const damagedValue = adjusted.filter(i => i.adjustmentType === 'DAMAGED').reduce((sum, i) => sum + (Number(i.lossValue) || 0), 0);
        const missingValue = adjusted.filter(i => i.adjustmentType === 'MISSING').reduce((sum, i) => sum + (Number(i.lossValue) || 0), 0);
        return {
            stocktake,
            itemCount: rows.length,
            adjustedCount: adjusted.length,
            matchedCount: matched.length,
            completedCount: adjusted.length + matched.length,
            pendingCount: rows.filter(i => i.status === 'PENDING').length,
            increase,
            decrease,
            damagedCount: adjusted.filter(i => i.adjustmentType === 'DAMAGED').reduce((sum, i) => sum + Math.abs(Math.min(0, Number(i.difference) || 0)), 0),
            missingCount: adjusted.filter(i => i.adjustmentType === 'MISSING').reduce((sum, i) => sum + Math.abs(Math.min(0, Number(i.difference) || 0)), 0),
            damagedValue,
            missingValue,
            totalLossValue: damagedValue + missingValue
        };
    }

    static getDashboardStats(financialNetProfit = 0) {
        const data = InventoryService.loadData();
        const stocktakes = (data.stocktakes || []).filter(s => s.hiddenFromList !== true).map(s => new Stocktake(s));
        const completed = stocktakes.filter(s => s.status === 'COMPLETED').sort((a, b) => new Date(a.completedAt || a.createdAt || 0) - new Date(b.completedAt || b.createdAt || 0));
        const summaries = completed.map(s => this.buildSummary(s, (data.stocktakeItems || []).filter(i => i.stocktakeId === s.id)));
        const totalMissingCount = summaries.reduce((sum, s) => sum + s.missingCount, 0);
        const totalDamagedCount = summaries.reduce((sum, s) => sum + s.damagedCount, 0);
        const totalMissingValue = summaries.reduce((sum, s) => sum + s.missingValue, 0);
        const totalDamagedValue = summaries.reduce((sum, s) => sum + s.damagedValue, 0);
        let avgDays = 0;
        if (completed.length > 1) {
            let totalGap = 0;
            for (let i = 1; i < completed.length; i++) {
                totalGap += Math.abs(new Date(completed[i].completedAt || completed[i].createdAt) - new Date(completed[i - 1].completedAt || completed[i - 1].createdAt)) / 86400000;
            }
            avgDays = totalGap / (completed.length - 1);
        }
        const ordered = [...stocktakes].sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0));
        const latest = ordered[0] || null;
        const previous = latest ? ordered.filter(s => s.id !== latest.id && s.status === 'COMPLETED')[0] || null : null;
        const latestSummary = latest ? this.buildSummary(latest, (data.stocktakeItems || []).filter(i => i.stocktakeId === latest.id)) : null;
        const previousSummary = previous ? this.buildSummary(previous, (data.stocktakeItems || []).filter(i => i.stocktakeId === previous.id)) : null;
        const daysSinceLast = latest ? Math.floor((Date.now() - new Date(latest.completedAt || latest.createdAt).getTime()) / 86400000) : null;
        const baselineDays = avgDays > 0 ? Math.max(30, avgDays * 1.5) : 30;
        const latestLoss = latestSummary ? latestSummary.totalLossValue : 0;
        const previousLoss = previousSummary ? previousSummary.totalLossValue : 0;
        return {
            count: stocktakes.length,
            avgDays,
            totalMissingCount,
            totalMissingValue,
            totalDamagedCount,
            totalDamagedValue,
            totalLossValue: totalMissingValue + totalDamagedValue,
            lossToProfitPct: financialNetProfit > 0 ? ((totalMissingValue + totalDamagedValue) / financialNetProfit) * 100 : 0,
            latest,
            latestSummary,
            previousSummary,
            isLate: daysSinceLast === null || daysSinceLast > baselineDays,
            daysSinceLast,
            improvementPct: previousLoss > 0 ? ((previousLoss - latestLoss) / previousLoss) * 100 : 0,
            missingDropPct: previousSummary && previousSummary.missingValue > 0 ? ((previousSummary.missingValue - (latestSummary?.missingValue || 0)) / previousSummary.missingValue) * 100 : 0
        };
    }
}

/**
 * Invoice inventory synchronization service.
 */
class InvoiceInventoryService {
    static sync(invoice, options = {}) {
        if (!invoice || !invoice.id) return false;

        const data = InventoryService.loadData();

        if (options.delete) {
            this._cancelInvoiceMovements(data, invoice);
        } else {
            this._revertInvoiceMovements(data, invoice.id);
            this._applyInvoiceMovements(data, invoice);
        }

        InventoryService.saveData(data);
        return true;
    }

    static _cancelInvoiceMovements(data, invoice) {
        const invNumText = invoice.number ? ` رقم #${invoice.number}` : (invoice.id ? ` (#${String(invoice.id).substr(0, 6)})` : '');
        const noteText = `إلغاء فاتورة بيع${invNumText}`;
        const processedProductIds = new Set();

        if (Array.isArray(invoice.items) && invoice.items.length > 0) {
            invoice.items.forEach(item => {
                if (!item.inventoryProductId) return;

                const product = data.products.find(p => p.id === item.inventoryProductId);
                if (!product) return;

                const qtyToReturn = Math.abs(Number(item.qty) || 0);
                if (qtyToReturn <= 0) return;

                const balanceBefore = Number(product.currentQuantity || 0);
                const balanceAfter = balanceBefore + qtyToReturn;

                product.currentQuantity = balanceAfter;
                product.updatedAt = new Date().toISOString();

                data.stockMovements.push(new StockMovement({
                    id: 'mov_cncl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                    productId: product.id,
                    type: 'CANCELLED_SALE',
                    quantity: qtyToReturn,
                    balanceBefore: balanceBefore,
                    balanceAfter: balanceAfter,
                    invoiceId: invoice.id,
                    referenceId: invoice.id,
                    note: noteText,
                    createdAt: new Date().toISOString()
                }));

                processedProductIds.add(product.id);
            });
        }

        // Fallback: check any stockMovement recorded for this invoiceId
        (data.stockMovements || []).forEach(movement => {
            if (movement.type === 'SALE' && (movement.invoiceId || movement.referenceId) === invoice.id) {
                if (!processedProductIds.has(movement.productId)) {
                    const product = data.products.find(p => p.id === movement.productId);
                    if (product) {
                        const qtyToReturn = Math.abs(Number(movement.quantity) || 0);
                        if (qtyToReturn > 0) {
                            const balanceBefore = Number(product.currentQuantity || 0);
                            const balanceAfter = balanceBefore + qtyToReturn;

                            product.currentQuantity = balanceAfter;
                            product.updatedAt = new Date().toISOString();

                            data.stockMovements.push(new StockMovement({
                                id: 'mov_cncl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                                productId: product.id,
                                type: 'CANCELLED_SALE',
                                quantity: qtyToReturn,
                                balanceBefore: balanceBefore,
                                balanceAfter: balanceAfter,
                                invoiceId: invoice.id,
                                referenceId: invoice.id,
                                note: noteText,
                                createdAt: new Date().toISOString()
                            }));
                        }
                    }
                }
            }
        });
    }

    static _revertInvoiceMovements(data, invoiceId) {
        const remainingMovements = [];

        data.stockMovements.forEach(movement => {
            if (movement.type === 'SALE' && (movement.invoiceId || movement.referenceId) === invoiceId) {
                const product = data.products.find(p => p.id === movement.productId);
                if (product) {
                    product.currentQuantity = Number(product.currentQuantity || 0) - Number(movement.quantity || 0);
                    product.updatedAt = new Date().toISOString();
                }
                return;
            }

            remainingMovements.push(movement);
        });

        data.stockMovements = remainingMovements;
    }

    static _applyInvoiceMovements(data, invoice) {
        (invoice.items || []).forEach(item => {
            if (!item.inventoryProductId) return;

            const product = data.products.find(p => p.id === item.inventoryProductId);
            if (!product) return;

            const quantity = -(Number(item.qty) || 0);
            const balanceBefore = Number(product.currentQuantity || 0);
            const balanceAfter = balanceBefore + quantity;

            product.currentQuantity = balanceAfter;
            product.updatedAt = new Date().toISOString();
            data.stockMovements.push(new StockMovement({
                id: 'mov_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                productId: product.id,
                type: 'SALE',
                quantity: quantity,
                balanceBefore: balanceBefore,
                balanceAfter: balanceAfter,
                invoiceId: invoice.id,
                referenceId: invoice.id,
                createdAt: invoice.date || invoice.createdAt || new Date().toISOString()
            }));
        });
    }
}

/**
 * Purchases Service
 */
class PurchaseService {
    static getAll() {
        const data = InventoryService.loadData();
        return data.purchases.map(p => new Purchase(p));
    }

    static getById(id) {
        const purchases = this.getAll();
        return purchases.find(p => p.id === id) || null;
    }

    /**
     * Creates a purchase record, updates the product pricing, and records a stock movement.
     */
    static create(purchaseData) {
        const data = InventoryService.loadData();

        if (!purchaseData.productId) {
            throw new Error("Product ID is required");
        }
        if (Number(purchaseData.quantity) <= 0) {
            throw new Error("Quantity must be greater than zero");
        }

        const productIndex = data.products.findIndex(p => p.id === purchaseData.productId);
        if (productIndex === -1) {
            throw new Error(`Product with ID ${purchaseData.productId} not found`);
        }

        const purchaseId = 'pur_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const newPurchase = new Purchase({
            id: purchaseId,
            productId: purchaseData.productId,
            quantity: Number(purchaseData.quantity),
            costPrice: Number(purchaseData.costPrice) || 0,
            salePrice: Number(purchaseData.salePrice) || 0,
            supplier: purchaseData.supplier || '',
            customerId: purchaseData.customerId || '',
            createdAt: new Date().toISOString()
        });

        // Update product prices if provided
        const product = data.products[productIndex];
        if (purchaseData.costPrice !== undefined) {
            product.costPrice = Number(purchaseData.costPrice);
        }
        if (purchaseData.salePrice !== undefined) {
            product.salePrice = Number(purchaseData.salePrice);
        }
        product.updatedAt = new Date().toISOString();

        // Save purchase record
        data.purchases.push(newPurchase);
        InventoryService.saveData(data);

        // Update stock via StockService (records movement and updates currentQuantity)
        StockService.recordMovement(purchaseData.productId, 'PURCHASE', newPurchase.quantity, purchaseId);

        return newPurchase;
    }

    /**
     * Updates an existing purchase record, adjusts product pricing, and corrects
     * the stock count by recording a MANUAL adjustment for the quantity delta.
     */
    static update(id, updateData) {
        const data = InventoryService.loadData();
        const index = data.purchases.findIndex(p => p.id === id);
        if (index === -1) {
            throw new Error(`Purchase with ID ${id} not found`);
        }

        const existing = data.purchases[index];
        const oldQty = Number(existing.quantity) || 0;
        const newQty = Number(updateData.quantity) !== undefined ? Number(updateData.quantity) : oldQty;

        if (newQty <= 0) {
            throw new Error('Quantity must be greater than zero');
        }

        // Build the updated purchase record
        const updatedPurchase = new Purchase({
            ...existing,
            quantity: newQty,
            costPrice: updateData.costPrice !== undefined ? Number(updateData.costPrice) : Number(existing.costPrice),
            salePrice: updateData.salePrice !== undefined ? Number(updateData.salePrice) : Number(existing.salePrice),
            supplier: updateData.supplier !== undefined ? updateData.supplier : existing.supplier,
            customerId: updateData.customerId !== undefined ? updateData.customerId : (existing.customerId || '')
        });

        data.purchases[index] = updatedPurchase;

        // Update product prices
        const productIndex = data.products.findIndex(p => p.id === existing.productId);
        if (productIndex !== -1) {
            const product = data.products[productIndex];
            if (updateData.costPrice !== undefined) product.costPrice = updatedPurchase.costPrice;
            if (updateData.salePrice !== undefined) product.salePrice = updatedPurchase.salePrice;
            product.updatedAt = new Date().toISOString();
        }

        InventoryService.saveData(data);

        // Adjust inventory by the quantity delta (avoids rewriting full movement history)
        const delta = newQty - oldQty;
        if (delta !== 0) {
            try {
                StockService.recordMovement(existing.productId, 'MANUAL', delta, `edit_purchase_${id}`);
            } catch (e) {
                console.error('Failed to adjust stock after purchase update:', e);
            }
        }

        return updatedPurchase;
    }

    /**
     * Deletes a purchase record and reverts the stock movement.
     */
    static delete(id) {
        const data = InventoryService.loadData();
        const index = data.purchases.findIndex(p => p.id === id);
        if (index === -1) {
            throw new Error(`Purchase with ID ${id} not found`);
        }

        const purchase = data.purchases[index];

        // Delete purchase record
        data.purchases.splice(index, 1);
        InventoryService.saveData(data);

        // Revert the purchased stock by recording a negative stock movement
        try {
            StockService.recordMovement(purchase.productId, 'MANUAL', -purchase.quantity, `delete_purchase_${purchase.id}`);
        } catch (e) {
            console.error("Failed to revert stock after purchase deletion:", e);
        }

        return true;
    }
}

// ==========================================
// 3. Global Expose
// ==========================================

/**
 * Utility to convert Arabic and Persian numerals to English digits.
 */
function toEnglishDigits(str) {
    if (str === null || str === undefined) return '';
    str = String(str);
    const persianDigits = [/۰/g, /۱/g, /۲/g, /۳/g, /۴/g, /۵/g, /۶/g, /۷/g, /۸/g, /۹/g];
    const arabicDigits = [/٠/g, /١/g, /٢/g, /٣/g, /٤/g, /٥/g, /٦/g, /٧/g, /٨/g, /٩/g];
    for (let i = 0; i < 10; i++) {
        str = str.replace(persianDigits[i], i).replace(arabicDigits[i], i);
    }
    return str;
}
window.toEnglishDigits = toEnglishDigits;

window.Product = Product;
window.Category = Category;
window.Purchase = Purchase;
window.StockMovement = StockMovement;
window.Stocktake = Stocktake;
window.StocktakeItem = StocktakeItem;

window.InventoryService = InventoryService;
window.ProductService = ProductService;
window.CategoryService = CategoryService;
window.StockService = StockService;
window.InvoiceInventoryService = InvoiceInventoryService;
window.PurchaseService = PurchaseService;
window.StocktakeService = StocktakeService;

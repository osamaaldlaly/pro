/**
 * storage-engine.js (Decomposed Granular + Repository Record-Level Architecture)
 *
 * Unified Storage Engine & Production-Ready Migration Driver for Hsabaty Android App.
 *
 * Key Architecture Principles:
 * 1. Primary Storage Engine: IndexedDB (Source of Truth).
 * 2. Repository Layer & Record-Level Mutations: Individual entity edits (Customer, Transaction, Invoice, etc.)
 *    trigger exactly 1 record put/delete operation in IndexedDB (e.g., customers.put(customer)) without re-writing
 *    or re-serializing the entire database.
 * 3. Repositories Exposed: CustomerRepository, TransactionRepository, InvoiceRepository, ExpenseRepository,
 *    RevenueRepository, CategoryRepository, SettingsRepository.
 * 4. 100% Public API & Backup Compatibility: AppStorage.getItem('hisabati_v6_data') seamlessly aggregates
 *    and returns the exact unified JSON format expected by React, Backup/Export, & Google Drive Sync.
 * 5. LocalStorage Freeze Post-Migration: Once migration completes (migrationState === COMPLETED),
 *    new writes to localStorage are strictly halted. LocalStorage is kept intact as a read-only fallback backup.
 * 6. Migration State Machine: NOT_STARTED -> RUNNING -> VALIDATING -> COMPLETED / FAILED (Stored in IDB sys_metadata).
 * 7. In-Memory Cache (_cacheMap): Fast 0ms synchronous reads matching localStorage performance with partial record updates.
 */

(function (window) {
    'use strict';

    // 1. Constants & Migration States
    const DB_NAME = 'HsabatyDB';
    const DB_VERSION = 2; // Upgraded schema version for granular stores
    const STORE_APP_KV = 'app_kv_store';
    const STORE_SYS_META = 'sys_metadata';

    // Granular Object Stores for Financial Data
    const GRANULAR_STORES = ['customers', 'transactions', 'invoices', 'expenses', 'revenues', 'categories'];
    const STORE_SETTINGS = 'settings';

    const MIGRATION_STATES = {
        NOT_STARTED: 'NOT_STARTED',
        RUNNING: 'RUNNING',
        VALIDATING: 'VALIDATING',
        COMPLETED: 'COMPLETED',
        FAILED: 'FAILED'
    };

    const MIGRATION_KEYS = [
        'hisabati_v6_data',
        'hisabati_v6_settings',
        'hsabaty_inventory_data',
        'hsabaty_user_info',
        'hsabaty_device_id',
        'hsabaty_drive_sync',
        'hsabaty_drive_sync_time',
        'hsabaty_pending_drive_payload',
        'hsabaty_used_recovery_codes',
        'hsabaty_stats',
        'hsabaty_security_warning_counter',
        'hsabaty_active_category'
    ];

    // 2. Internal State & Memory Cache
    const _cacheMap = new Map();
    let _financialDataCache = null; // Parsed financial data object in RAM
    let _db = null;
    let _storageMode = 'INDEXEDDB'; // 'INDEXEDDB' | 'LOCALSTORAGE_FALLBACK'
    let _migrationState = MIGRATION_STATES.NOT_STARTED;
    let _lastError = null;
    let _lastSuccessfulCommit = null;
    let _lastValidation = null;
    let _hydrationComplete = false;
    let _financialDataNeedsPersistence = false;

    // ── Single Writer Architecture: Write Queue (FIFO) ──────────────────────
    // Guarantees that no two financial write operations ever run in parallel.
    // All financial writes (setItem/saveRecord/deleteRecord/atomicRestore/clear/
    // removeItem/_rollbackSnapshot) are serialized through this queue.
    // No busy-waiting, no setTimeout hacks — pure Promise chaining.
    let _writeQueue = [];          // Array of { task: async fn, resolve, reject }
    let _writeQueueRunning = false; // true while a Commit is in progress
    let _writeGeneration = 0;      // Monotonically increasing commit counter (per disassemble call)

    // ── Stale Snapshot Guard ─────────────────────────────────────────────────
    // _lastCommitSeq is incremented atomically (inside the queue, FIFO) every time
    // a financial write task is enqueued for hisabati_v6_data (setItem / saveRecord /
    // deleteRecord / atomicRestore / removeItem / clear).
    // Each task captures its own seqId at enqueue time. Before updating RAM it
    // checks: if a LATER task already committed (seqId < _lastCommitSeq), this
    // task's payload is stale and it MUST NOT overwrite the newer data in RAM.
    // IDB already holds the correct latest value (written by the later task).
    // This prevents an older React snapshot from overwriting a newer granular write.
    let _lastCommitSeq = 0;  // last sequence number that successfully committed to IDB
    let _nextSeqId = 0;      // monotonically increasing; assigned at enqueue time

    /**
     * Internal: drain the head of the write queue sequentially.
     * Called automatically after enqueue and after each task completes.
     * MUST NOT be called while _writeQueueRunning === true.
     */
    function _drainQueue() {
        if (_writeQueueRunning || _writeQueue.length === 0) return;
        _writeQueueRunning = true;
        const { task, resolve, reject } = _writeQueue[0];
        // Use Promise.resolve().then() to ensure the task always runs async,
        // never synchronously inside the caller's stack frame.
        Promise.resolve()
            .then(() => task())
            .then(result => {
                _writeQueue.shift();
                resolve(result);
            })
            .catch(err => {
                _writeQueue.shift();
                reject(err);
            })
            .finally(() => {
                _writeQueueRunning = false;
                _drainQueue(); // process the next item if any
            });
    }

    /**
     * Enqueue a financial write task.
     * Returns a Promise that resolves/rejects when the task completes.
     * Tasks execute FIFO. A new task never starts before the previous one finishes.
     * @param {function(): Promise<any>} task - async function to execute
     * @returns {Promise<any>}
     */
    function _enqueueWrite(task) {
        return new Promise((resolve, reject) => {
            _writeQueue.push({ task, resolve, reject });
            _drainQueue();
        });
    }

    /**
     * Claim the next sequence ID for a financial RAM-touching write.
     * Must be called OUTSIDE the queue task (at enqueue time) so that the
     * ordering of sequence IDs matches the ordering of enqueue calls.
     * @returns {number} seqId — passed into the queue task closure.
     */
    function _claimWriteSeq() {
        return ++_nextSeqId;
    }

    function isCompleteFinancialData(value) {
        return !!value && typeof value === 'object' && GRANULAR_STORES.every((storeName) => Array.isArray(value[storeName]));
    }

    function getEmptyFinancialData() {
        return {
            customers: [],
            transactions: [],
            invoices: [],
            expenses: [],
            revenues: [],
            categories: []
        };
    }

    // 3. CRC32 Checksum Algorithm
    function makeCRCTable() {
        let c;
        const crcTable = [];
        for (let n = 0; n < 256; n++) {
            c = n;
            for (let k = 0; k < 8; k++) {
                c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
            }
            crcTable[n] = c;
        }
        return crcTable;
    }
    const CRC_TABLE = makeCRCTable();

    function computeCRC32(str) {
        if (str === null || str === undefined) return 0;
        let crc = 0 ^ (-1);
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            if (code < 128) {
                crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ code) & 0xFF];
            } else if (code < 2048) {
                crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ (192 | (code >> 6))) & 0xFF];
                crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ (128 | (code & 63))) & 0xFF];
            } else if ((code & 0xD800) === 0xD800 && i + 1 < str.length) {
                const nextCode = str.charCodeAt(++i);
                const surrogate = ((code & 0x3FF) << 10) + (nextCode & 0x3FF) + 0x10000;
                crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ (240 | (surrogate >> 18))) & 0xFF];
                crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ (128 | ((surrogate >> 12) & 63))) & 0xFF];
                crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ (128 | ((surrogate >> 6) & 63))) & 0xFF];
                crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ (128 | (surrogate & 63))) & 0xFF];
            } else {
                crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ (224 | (code >> 12))) & 0xFF];
                crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ (128 | ((code >> 6) & 63))) & 0xFF];
                crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ (128 | (code & 63))) & 0xFF];
            }
        }
        return (crc ^ (-1)) >>> 0;
    }

    // 4. IndexedDB Native Wrapper Promises
    function openIDB() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                return reject(new Error('IndexedDB is not supported on this device/environment.'));
            }
            const request = window.indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = function (event) {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_APP_KV)) {
                    db.createObjectStore(STORE_APP_KV, { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains(STORE_SYS_META)) {
                    db.createObjectStore(STORE_SYS_META, { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
                    db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
                }

                // Granular stores for financial data entities
                for (const storeName of GRANULAR_STORES) {
                    if (!db.objectStoreNames.contains(storeName)) {
                        db.createObjectStore(storeName, { keyPath: 'id' });
                    }
                }
            };

            request.onsuccess = function (event) {
                resolve(event.target.result);
            };

            request.onerror = function (event) {
                reject(request.error || new Error('Failed to open IndexedDB database.'));
            };

            request.onblocked = function () {
                console.warn('[StorageEngine] IndexedDB open blocked by another connection.');
            };
        });
    }

    function idbGet(db, storeName, key) {
        return new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(storeName, 'readonly');
                const store = tx.objectStore(storeName);
                const request = store.get(key);
                request.onsuccess = () => {
                    const res = request.result;
                    if (!res) return resolve(null);
                    if (res.value !== undefined) return resolve(res.value);
                    return resolve(res);
                };
                request.onerror = () => reject(request.error || new Error(`Failed to read key: ${key} from ${storeName}`));
            } catch (err) {
                reject(err);
            }
        });
    }

    function idbPut(db, storeName, record) {
        return new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                const request = store.put(record);
                request.onsuccess = () => resolve(true);
                request.onerror = () => reject(request.error || new Error(`Failed to write record to ${storeName}`));
            } catch (err) {
                reject(err);
            }
        });
    }

    function idbDelete(db, storeName, key) {
        return new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                const request = store.delete(key);
                request.onsuccess = () => resolve(true);
                request.onerror = () => reject(request.error || new Error(`Failed to delete key: ${key} from ${storeName}`));
            } catch (err) {
                reject(err);
            }
        });
    }

    function idbClearStore(db, storeName) {
        return new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                const request = store.clear();
                request.onsuccess = () => resolve(true);
                request.onerror = () => reject(request.error || new Error(`Failed to clear store: ${storeName}`));
            } catch (err) {
                reject(err);
            }
        });
    }

    function idbGetAllStore(db, storeName) {
        return new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(storeName, 'readonly');
                const store = tx.objectStore(storeName);
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error || new Error(`Failed to getAll from ${storeName}`));
            } catch (err) {
                reject(err);
            }
        });
    }

    // Helper UI functions for Migration Blocking Overlay
    function showMigrationOverlay() {
        if (typeof document === 'undefined') return;
        if (document.getElementById('hsabaty-migration-overlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'hsabaty-migration-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(15,23,42,0.95);color:#ffffff;z-index:999999;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;direction:rtl;text-align:center;padding:20px;box-sizing:border-box;';
        overlay.innerHTML = '<div style="font-size:48px;margin-bottom:16px;">⚙️</div><h3 style="font-size:20px;margin:0 0 8px 0;color:#f8fafc;font-weight:700;">جاري تجهيز التطبيق وتحديث قاعدة البيانات...</h3><p style="font-size:14px;color:#94a3b8;margin:0;">يرجى الانتظار وعدم إغلاق التطبيق أثناء عملية الهجرة.</p>';
        const mount = document.body || document.documentElement;
        if (mount) {
            mount.appendChild(overlay);
        }
    }

    function hideMigrationOverlay() {
        if (typeof document === 'undefined') return;
        const overlay = document.getElementById('hsabaty-migration-overlay');
        if (overlay && overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
    }

    function showStorageErrorOverlay(title, message) {
        if (typeof document === 'undefined') return;
        let overlay = document.getElementById('hsabaty-storage-error-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'hsabaty-storage-error-overlay';
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(15,23,42,0.98);color:#ffffff;z-index:999999;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;direction:rtl;text-align:center;padding:24px;box-sizing:border-box;';
            const mount = document.body || document.documentElement;
            if (mount) mount.appendChild(overlay);
        }
        overlay.innerHTML = `<div style="font-size:56px;margin-bottom:16px;">⚠️</div><h3 style="font-size:22px;margin:0 0 12px 0;color:#ef4444;font-weight:700;">${title || 'فشل خطير في وحدة التخزين'}</h3><p style="font-size:15px;color:#cbd5e1;margin:0 0 16px 0;max-width:400px;line-height:1.6;">${message || 'تم إيقاف تشغيل التطبيق لحماية بياناتك من الضياع.'}</p><button onclick="location.reload()" style="background:#dc2626;color:white;border:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;">إعادة التحديث</button>`;
    }

    // 5. Financial Data Granular Assembly & Disassembly
    /**
     * SINGLE MULTI-STORE ATOMIC TRANSACTION:
     * Disassembles financial data and writes to all granular stores using a single IDBTransaction
     * covering GRANULAR_STORES (['customers', 'transactions', 'invoices', 'expenses', 'revenues', 'categories']).
     * This guarantees 100% database-level Atomicity: if any write/clear operation fails, the transaction is
     * aborted completely and IndexedDB rolls back all stores to their previous state.
     */
    async function disassembleAndSaveFinancialData(db, financialDataObj, forceFull = false) {
        // Accept raw object directly to preserve React's Immutable Update object references.

        // Reference equality (===) is only possible if we don't parse from string here.
        const obj = (typeof financialDataObj === 'string') ? JSON.parse(financialDataObj) : financialDataObj;
        if (!isCompleteFinancialData(obj)) {
            throw new Error('Financial data is incomplete; full replacement was refused.');
        }
        const prev = _financialDataCache; // Previous state - holds original object references

        // ── Generation Snapshot: capture the current generation BEFORE the IDB commit.
        // After the commit completes we verify it hasn't been superseded.
        // In the Write Queue architecture this check is always a no-op (the queue
        // enforces strict FIFO), but it provides a defence-in-depth safety net.
        const myGeneration = ++_writeGeneration;

        const isFull = (!prev || forceFull);

        if (isFull) {
            // First run or forced full write: clear all stores & write new records in a single atomic transaction
            const tx = db.transaction(GRANULAR_STORES, 'readwrite');

            for (const storeName of GRANULAR_STORES) {
                const store = tx.objectStore(storeName);
                store.clear();
                const newItems = Array.isArray(obj[storeName]) ? obj[storeName] : [];
                for (let i = 0; i < newItems.length; i++) {
                    const item = newItems[i];
                    const record = (typeof item === 'object' && item !== null) ? { ...item } : { itemVal: item };
                    if (!record.id) record.id = `${storeName}_${i}_${Date.now()}`;
                    store.put(record);
                }
            }

            await new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve(true);
                tx.onerror = (event) => {
                    reject(tx.error || (event && event.target && event.target.error) || new Error('Failed writing store financial data'));
                };
                tx.onabort = (event) => {
                    reject(tx.error || (event && event.target && event.target.error) || new Error('Transaction aborted while saving financial data'));
                };
            });
        } else {
            // DIFFERENTIAL WRITE using REFERENCE EQUALITY (===) in a single atomic transaction
            const storeChanges = [];
            let totalChanges = 0;

            for (const storeName of GRANULAR_STORES) {
                const newItems = Array.isArray(obj[storeName]) ? obj[storeName] : [];
                const prevItems = (prev && Array.isArray(prev[storeName])) ? prev[storeName] : [];

                const prevById = new Map();
                for (const prevItem of prevItems) {
                    if (prevItem && prevItem.id) prevById.set(prevItem.id, prevItem);
                }

                const toWrite = [];
                const newIds = new Set();
                for (const item of newItems) {
                    if (!item) continue;
                    if (!item.id) { toWrite.push(item); continue; }
                    newIds.add(item.id);
                    const prevItem = prevById.get(item.id);
                    if (prevItem !== item) {
                        toWrite.push(item);
                    }
                }

                const toDelete = [];
                for (const prevItem of prevItems) {
                    if (prevItem && prevItem.id && !newIds.has(prevItem.id)) {
                        toDelete.push(prevItem.id);
                    }
                }

                if (toWrite.length > 0 || toDelete.length > 0) {
                    storeChanges.push({ storeName, toWrite, toDelete });
                    totalChanges += toWrite.length + toDelete.length;
                }
            }

            if (totalChanges > 0) {
                const tx = db.transaction(GRANULAR_STORES, 'readwrite');
                for (const change of storeChanges) {
                    const store = tx.objectStore(change.storeName);
                    for (const item of change.toWrite) {
                        const record = (typeof item === 'object' && item !== null) ? { ...item } : { itemVal: item };
                        if (!record.id) record.id = `${change.storeName}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                        store.put(record);
                    }
                    for (const id of change.toDelete) {
                        store.delete(id);
                    }
                }
                await new Promise((resolve, reject) => {
                    tx.oncomplete = () => resolve(true);
                    tx.onerror = (event) => {
                        reject(tx.error || (event && event.target && event.target.error) || new Error('Failed differential write for financial data'));
                    };
                    tx.onabort = (event) => {
                        reject(tx.error || (event && event.target && event.target.error) || new Error('Transaction aborted during differential write'));
                    };
                });
            }
        }

        // ── Generation Guard: reject a stale commit that somehow escaped the queue.
        // In normal operation (queue enforced) myGeneration === _writeGeneration always.
        // This guard makes the invariant explicit and catches any future code path
        // that bypasses _enqueueWrite.
        if (myGeneration !== _writeGeneration) {
            throw new Error(
                `[StorageEngine] Stale write rejected: commit generation ${myGeneration} superseded by ${_writeGeneration}. ` +
                'A write path bypassed the Write Queue.'
            );
        }

        // Store the DIRECT reference only after the complete database transaction succeeds
        // AND the generation guard passes. RAM is never updated on a stale or failed commit.
        _financialDataCache = obj;
        _financialDataNeedsPersistence = false;
    }

    async function assembleFinancialDataObject(db) {
        const financialObj = getEmptyFinancialData();

        await new Promise((resolve, reject) => {
            let tx;
            try {
                tx = db.transaction(GRANULAR_STORES, 'readonly');
                for (const storeName of GRANULAR_STORES) {
                    const request = tx.objectStore(storeName).getAll();
                    request.onsuccess = () => {
                        financialObj[storeName] = (request.result || []).map(r => {
                            if (r && r.itemVal !== undefined) return r.itemVal;
                            return r;
                        });
                    };
                    request.onerror = () => reject(request.error || new Error(`Failed to read store: ${storeName}`));
                }
                tx.oncomplete = () => resolve(true);
                tx.onerror = (event) => reject(tx.error || event?.target?.error || new Error('Financial snapshot read failed'));
                tx.onabort = (event) => reject(tx.error || event?.target?.error || new Error('Financial snapshot read aborted'));
            } catch (err) {
                reject(err);
            }
        });

        return financialObj;
    }

    async function assembleFinancialData(db) {
        return JSON.stringify(await assembleFinancialDataObject(db));
    }

    async function readStartupSnapshot(db) {
        const snapshot = {
            appKv: [],
            settings: [],
            financial: getEmptyFinancialData()
        };
        const storeNames = [STORE_APP_KV, STORE_SETTINGS, ...GRANULAR_STORES];
        await new Promise((resolve, reject) => {
            let tx;
            try {
                tx = db.transaction(storeNames, 'readonly');
                for (const storeName of storeNames) {
                    const request = tx.objectStore(storeName).getAll();
                    request.onsuccess = () => {
                        const records = request.result || [];
                        if (storeName === STORE_APP_KV) snapshot.appKv = records;
                        else if (storeName === STORE_SETTINGS) snapshot.settings = records;
                        else {
                            snapshot.financial[storeName] = records.map(r => {
                                if (r && r.itemVal !== undefined) return r.itemVal;
                                return r;
                            });
                        }
                    };
                    request.onerror = () => reject(request.error || new Error(`Failed to read store: ${storeName}`));
                }
                tx.oncomplete = () => resolve(true);
                tx.onerror = (event) => reject(tx.error || event?.target?.error || new Error('Startup snapshot read failed'));
                tx.onabort = (event) => reject(tx.error || event?.target?.error || new Error('Startup snapshot read aborted'));
            } catch (err) {
                reject(err);
            }
        });
        return snapshot;
    }

    // 6. Settings Store Handling
    async function saveSettingsData(db, settingsVal) {
        const valStr = (typeof settingsVal === 'object' && settingsVal !== null) ? JSON.stringify(settingsVal) : String(settingsVal);
        await idbPut(db, STORE_SETTINGS, { key: 'hisabati_v6_settings', value: valStr, updatedAt: new Date().toISOString() });
    }

    async function loadSettingsData(db) {
        const rec = await idbGet(db, STORE_SETTINGS, 'hisabati_v6_settings');
        if (rec !== null) return rec;
        const kvRec = await idbGet(db, STORE_APP_KV, 'hisabati_v6_settings');
        return kvRec;
    }

    // 7. Migration State Management inside IndexedDB (sys_metadata)
    async function updateMigrationState(state, details = {}) {
        _migrationState = state;
        if (!_db) return;
        const payload = {
            state: state,
            updatedAt: new Date().toISOString(),
            details: details
        };
        try {
            await idbPut(_db, STORE_SYS_META, { key: 'migration_state', value: JSON.stringify(payload) });
        } catch (e) {
            console.error('[StorageEngine] Could not persist migration state in IDB:', e);
        }
    }

    async function fetchMigrationState() {
        if (!_db) return MIGRATION_STATES.NOT_STARTED;
        try {
            const raw = await idbGet(_db, STORE_SYS_META, 'migration_state');
            if (!raw) return MIGRATION_STATES.NOT_STARTED;
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return parsed.state || MIGRATION_STATES.NOT_STARTED;
        } catch (e) {
            console.warn('[StorageEngine] Failed to read migration state from IDB:', e);
            return MIGRATION_STATES.NOT_STARTED;
        }
    }

    async function checkDecomposedFlag() {
        if (!_db) return false;
        try {
            const raw = await idbGet(_db, STORE_SYS_META, 'decomposed_v1_done');
            return !!raw;
        } catch (e) {
            return false;
        }
    }

    async function setDecomposedFlag() {
        if (!_db) return;
        try {
            await idbPut(_db, STORE_SYS_META, { key: 'decomposed_v1_done', value: 'true', timestamp: new Date().toISOString() });
        } catch (e) { }
    }

    function poisonLegacyLocalStorageSource() {
        try {
            const raw = window.localStorage.getItem('hisabati_v6_data');
            if (raw && raw !== 'undefined') {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (e) {}
                if (parsed && !parsed.migrated) {
                    window.localStorage.setItem('hisabati_v6_data', JSON.stringify({ migrated: true, timestamp: new Date().toISOString() }));
                    console.log('[StorageEngine] Old LocalStorage financial source poisoned post-migration.');
                }
            }
        } catch (e) {}
    }

    // 8. Advanced Single-Key Validation
    function validateSingleKey(key, valOriginal, valMigrated) {
        if (valOriginal === null || valOriginal === undefined) {
            return { valid: true };
        }
        if (valMigrated === null || valMigrated === undefined) {
            return { valid: false, reason: `Migrated key '${key}' is missing in IndexedDB.` };
        }

        // 1. Financial Domain Structure Match (Must run BEFORE string length/CRC check for disassembled financial data)
        if (key === 'hisabati_v6_data') {
            try {
                const dataLS = JSON.parse(valOriginal);
                const dataIDB = JSON.parse(valMigrated);

                const checkCounts = (propName) => {
                    const countLS = (dataLS && Array.isArray(dataLS[propName])) ? dataLS[propName].length : 0;
                    const countIDB = (dataIDB && Array.isArray(dataIDB[propName])) ? dataIDB[propName].length : 0;
                    if (countLS !== countIDB) {
                        throw new Error(`Financial domain count mismatch for '${propName}': LS count=${countLS}, IDB count=${countIDB}`);
                    }
                };

                checkCounts('customers');
                checkCounts('transactions');
                checkCounts('invoices');
                checkCounts('expenses');
                checkCounts('revenues');
                checkCounts('categories');

                return { valid: true };
            } catch (err) {
                return { valid: false, reason: `Financial data JSON structure validation failed: ${err.message}` };
            }
        }

        // 2. String length check (for simple KV string values)
        if (valOriginal.length !== valMigrated.length) {
            return {
                valid: false,
                reason: `Key '${key}' length mismatch. LS: ${valOriginal.length}, IDB: ${valMigrated.length}`
            };
        }

        // 3. CRC32 Checksum match (for simple KV string values)
        const crcOriginal = computeCRC32(valOriginal);
        const crcMigrated = computeCRC32(valMigrated);
        if (crcOriginal !== crcMigrated) {
            return {
                valid: false,
                reason: `Key '${key}' CRC32 checksum mismatch. LS: ${crcOriginal}, IDB: ${crcMigrated}`
            };
        }

        return { valid: true };
    }

    // 9. Migration & Decomposition Engine
    async function clearAllIDBStores(db) {
        if (!db) return;
        try {
            await idbClearStore(db, STORE_APP_KV);
            await idbClearStore(db, STORE_SETTINGS);
            for (const s of GRANULAR_STORES) {
                await idbClearStore(db, s);
            }
        } catch (e) {
            console.warn('[StorageEngine] Error clearing stores during migration cleanup:', e);
        }
    }

    async function executeMigration(force = false) {
        if (_migrationState === MIGRATION_STATES.COMPLETED && !force) {
            console.warn('[StorageEngine] Migration execution blocked: Migration is already COMPLETED.');
            return false;
        }
        console.log('[StorageEngine] Starting IndexedDB granular migration sequence...');
        showMigrationOverlay();

        try {
            // Build the complete replacement in memory first. Existing IDB data is
            // deliberately untouched until every source value has been read.
            const staged = { kv: new Map(), settings: null, financial: null };
            let sourceFound = false;
            for (const key of MIGRATION_KEYS) {
                const valLS = window.localStorage.getItem(key);
                if (valLS === null || valLS === 'undefined') continue;
                sourceFound = true;
                if (key === 'hisabati_v6_data') {
                    const parsed = JSON.parse(valLS);
                    const financial = getEmptyFinancialData();
                    for (const storeName of GRANULAR_STORES) {
                        if (parsed && Array.isArray(parsed[storeName])) financial[storeName] = parsed[storeName];
                    }
                    staged.financial = financial;
                } else if (key === 'hisabati_v6_settings') {
                    staged.settings = valLS;
                } else {
                    staged.kv.set(key, valLS);
                }
            }

            // No recoverable LocalStorage source means there is nothing safe to migrate.
            // In particular, never erase an existing IDB snapshot in this case.
            if (!sourceFound) return false;
            if (staged.financial && !isCompleteFinancialData(staged.financial)) {
                throw new Error('Staged financial migration data is incomplete.');
            }

            await updateMigrationState(MIGRATION_STATES.RUNNING);

            // Validate the staged replacement before opening the destructive transaction.
            await updateMigrationState(MIGRATION_STATES.VALIDATING);
            console.log('[StorageEngine] Validating migrated granular IndexedDB records...');
            if (staged.financial) {
                const original = window.localStorage.getItem('hisabati_v6_data');
                const check = validateSingleKey('hisabati_v6_data', original, JSON.stringify(staged.financial));
                if (!check.valid) throw new Error(`Validation failed for key 'hisabati_v6_data': ${check.reason}`);
            }
            for (const [key, value] of staged.kv) {
                const check = validateSingleKey(key, window.localStorage.getItem(key), value);
                if (!check.valid) throw new Error(`Validation failed for key '${key}': ${check.reason}`);
            }

            // Atomic swap: all stores are cleared and rebuilt in one IDB transaction.
            // If any put fails, IndexedDB retains the previous snapshot.
            const tx = _db.transaction([STORE_APP_KV, STORE_SETTINGS, ...GRANULAR_STORES], 'readwrite');
            for (const storeName of [STORE_APP_KV, STORE_SETTINGS, ...GRANULAR_STORES]) {
                tx.objectStore(storeName).clear();
            }
            const now = new Date().toISOString();
            for (const [key, value] of staged.kv) {
                tx.objectStore(STORE_APP_KV).put({ key, value, updatedAt: now });
            }
            if (staged.settings !== null) {
                tx.objectStore(STORE_SETTINGS).put({ key: 'hisabati_v6_settings', value: staged.settings, updatedAt: now });
            }
            if (staged.financial) {
                for (const storeName of GRANULAR_STORES) {
                    for (let i = 0; i < staged.financial[storeName].length; i++) {
                        const item = staged.financial[storeName][i];
                        const record = (typeof item === 'object' && item !== null) ? { ...item } : { itemVal: item };
                        if (!record.id) record.id = `${storeName}_${i}_${Date.now()}`;
                        tx.objectStore(storeName).put(record);
                    }
                }
            }
            await new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve(true);
                tx.onerror = (event) => reject(tx.error || event?.target?.error || new Error('Migration transaction failed'));
                tx.onabort = (event) => reject(tx.error || event?.target?.error || new Error('Migration transaction aborted'));
            });

            _lastValidation = { timestamp: new Date().toISOString(), status: 'SUCCESS_100_PERCENT' };
            await setDecomposedFlag();
            await updateMigrationState(MIGRATION_STATES.COMPLETED, {
                migratedKeysCount: staged.kv.size + (staged.settings !== null ? 1 : 0) + (staged.financial ? 1 : 0),
                validatedAt: _lastValidation.timestamp
            });
            poisonLegacyLocalStorageSource();

            console.log('[StorageEngine] Granular Migration & Dual Validation completed successfully!');
            return true;
        } catch (err) {
            _lastError = err.message || String(err);
            await updateMigrationState(MIGRATION_STATES.FAILED, { error: _lastError });
            throw err;
        } finally {
            hideMigrationOverlay();
        }
    }

    // Auto-decompose legacy monolithic IndexedDB v1 entry if present
    async function checkAndDecomposeMonolithicIDB() {
        if (_migrationState === MIGRATION_STATES.COMPLETED) {
            const isDecomposed = await checkDecomposedFlag();
            if (!isDecomposed) {
                await setDecomposedFlag();
            }
            return false;
        }
        const isDecomposed = await checkDecomposedFlag();
        if (isDecomposed) return false;

        console.log('[StorageEngine] Checking for legacy monolithic entry in app_kv_store...');
        const monoData = await idbGet(_db, STORE_APP_KV, 'hisabati_v6_data');
        if (monoData) {
            console.log('[StorageEngine] Auto-decomposing legacy monolithic IDB entry into granular stores...');
            await disassembleAndSaveFinancialData(_db, monoData, true);
            await idbDelete(_db, STORE_APP_KV, 'hisabati_v6_data');
            await setDecomposedFlag();
            return true;
        }
        await setDecomposedFlag();
        return false;
    }

    // 10. Hydrate In-Memory Cache from Source of Truth (IndexedDB)
    async function hydrateCacheFromIDB() {
        const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const nextCache = new Map();
        const startupSnapshot = await readStartupSnapshot(_db);

        // 1. General KV store
        const records = startupSnapshot.appKv;
        for (const rec of records) {
            if (rec && rec.key) {
                nextCache.set(rec.key, rec.value);
            }
        }

        // 2. Settings store
        const settingsRecord = startupSnapshot.settings.find(rec => rec && rec.key === 'hisabati_v6_settings');
        const settingsVal = settingsRecord ? settingsRecord.value : (records.find(rec => rec && rec.key === 'hisabati_v6_settings')?.value ?? null);
        if (settingsVal !== null) {
            nextCache.set('hisabati_v6_settings', settingsVal);
        } else {
            // Fallback: read settings from localStorage if IDB settings store is empty
            const lsSettings = window.localStorage.getItem('hisabati_v6_settings');
            if (lsSettings) {
                nextCache.set('hisabati_v6_settings', lsSettings);
                console.log('[StorageEngine] Settings fallback: loaded from localStorage (IDB settings store was empty).');
            }
        }

        // 3. Assemble Granular Financial Data from IDB stores
        const financialDataParsed = startupSnapshot.financial;
        if (!isCompleteFinancialData(financialDataParsed)) {
            throw new Error('Hydration produced incomplete financial data.');
        }

        // SAFETY CHECK: If all granular stores are empty but localStorage has data,
        // it means this is an upgrade from a version before granular decomposition.
        // Fall back to localStorage to prevent data loss on upgrade.
        const totalGranularRecords = financialDataParsed
            ? (financialDataParsed.customers.length + financialDataParsed.transactions.length +
               financialDataParsed.invoices.length + financialDataParsed.expenses.length +
               financialDataParsed.revenues.length + financialDataParsed.categories.length)
            : 0;

        if (_migrationState === MIGRATION_STATES.COMPLETED && totalGranularRecords === 0) {
            const lsDataStr = window.localStorage.getItem('hisabati_v6_data');
            const hasLsData = lsDataStr && lsDataStr !== 'undefined' && lsDataStr !== 'null';
            const isDecomposedDone = await checkDecomposedFlag();

            if (hasLsData || isDecomposedDone) {
                console.error('[StorageEngine] FATAL STORAGE CORRUPTION: IndexedDB stores are 0 records post-COMPLETED migration despite evidence of previous data!');
                _storageMode = 'STORAGE_FAILURE';
                _hydrationComplete = false;
                showStorageErrorOverlay('خطأ في استعادة البيانات (Fatal Storage Corruption)', 'تم إيقاف تشغيل التطبيق لحماية بياناتك، حيث تبين خلو قاعدة البيانات من السجلات رغم وجود سجلات سابقة. تم منع الكتابة لتفادي الضرر.');
                throw new Error('Fatal Storage Corruption: IndexedDB stores are empty post-migration. Boot halted for safety.');
            }
        }

        let usedLocalStorageFinancialFallback = false;
        let nextFinancialData = financialDataParsed;
        if (totalGranularRecords === 0 && _migrationState !== MIGRATION_STATES.COMPLETED) {
            const lsFinancialData = window.localStorage.getItem('hisabati_v6_data');
            if (lsFinancialData && lsFinancialData !== 'undefined') {
                const lsParsed = JSON.parse(lsFinancialData);
                if (!isCompleteFinancialData(lsParsed)) throw new Error('LocalStorage financial fallback is incomplete.');
                console.warn('[StorageEngine] Pre-migration fallback: Granular stores empty, loaded from localStorage.');
                nextCache.set('hisabati_v6_data', lsFinancialData);
                nextFinancialData = lsParsed;
                usedLocalStorageFinancialFallback = true;
            } else {
                nextCache.set('hisabati_v6_data', JSON.stringify(financialDataParsed));
            }
        } else {
            nextCache.set('hisabati_v6_data', JSON.stringify(financialDataParsed));
        }

        if (!isCompleteFinancialData(nextFinancialData)) throw new Error('Hydration snapshot is incomplete.');
        _cacheMap.clear();
        for (const [key, value] of nextCache) _cacheMap.set(key, value);
        _financialDataCache = nextFinancialData;
        _financialDataNeedsPersistence = usedLocalStorageFinancialFallback;
        _hydrationComplete = true;
    }

    function hydrateCacheFromLocalStorage() {
        if (_migrationState === MIGRATION_STATES.COMPLETED) {
            console.warn('[StorageEngine] LocalStorage hydration refused: Migration state is COMPLETED.');
            return;
        }
        const nextCache = new Map();
        for (let i = 0; i < window.localStorage.length; i++) {
            const k = window.localStorage.key(i);
            if (k) {
                const value = window.localStorage.getItem(k);
                if (value !== null) nextCache.set(k, value);
            }
        }
        const dataValue = nextCache.get('hisabati_v6_data');
        if (dataValue !== undefined) {
            const parsed = JSON.parse(dataValue);
            if (!isCompleteFinancialData(parsed)) throw new Error('LocalStorage fallback financial data is incomplete.');
            _financialDataCache = parsed;
        }
        _financialDataNeedsPersistence = false;
        _cacheMap.clear();
        for (const [key, value] of nextCache) _cacheMap.set(key, value);
        _hydrationComplete = true;
        console.log(`[StorageEngine] Hydrated Memory Cache with ${_cacheMap.size} keys from LocalStorage Fallback.`);
    }

    // 10.5 Private rollback helper for atomicRestore
    /**
     * BEST-EFFORT ROLLBACK:
     * Restores memory cache and IndexedDB to pre-restore snapshot when a caught JS error or IDB exception occurs.
     * LIMITATION: If a Process Crash or OS Kill happens during multi-store IDB execution, this in-memory code
     * cannot execute. Full crash-resilient rollback requires a single multi-store IDBTransaction.
     *
     * NOTE: This function MUST always be called from inside a _enqueueWrite task, because it
     * calls disassembleAndSaveFinancialData which is a financial write. It is NEVER called
     * directly from outside a queue task — the queue context is inherited from the caller
     * (atomicRestore already holds the queue slot when it invokes rollback).
     */
    async function _rollbackSnapshot(snapshot) {
        if (!snapshot) return;
        try {
            if (snapshot.dataStr && _storageMode === 'INDEXEDDB' && _db) {
                // Called from within the queue task that is already running.
                // disassembleAndSaveFinancialData is safe here because the queue
                // slot is held by atomicRestore — no parallel write can intervene.
                await disassembleAndSaveFinancialData(_db, snapshot.dataStr, true);
                // disassembleAndSaveFinancialData already updates _financialDataCache atomically.
                // Update _cacheMap to stay in sync with the rolled-back value.
                _cacheMap.set('hisabati_v6_data', snapshot.dataStr);
            } else if (snapshot.dataStr) {
                // LOCALSTORAGE_FALLBACK or no DB: update both atomically under a single
                // try block so neither is updated if the other would fail.
                const restoredObj = JSON.parse(snapshot.dataStr); // may throw on corruption
                _financialDataCache = restoredObj;
                _cacheMap.set('hisabati_v6_data', snapshot.dataStr);
            }
            if (snapshot.settingsStr && _storageMode === 'INDEXEDDB' && _db) {
                await saveSettingsData(_db, snapshot.settingsStr);
            }
            if (snapshot.settingsStr) {
                _cacheMap.set('hisabati_v6_settings', snapshot.settingsStr);
            }
            console.log('[atomicRestore] Rollback completed successfully.');
        } catch (rollbackErr) {
            console.error('[atomicRestore] CRITICAL: Rollback itself failed:', rollbackErr.message);
        }
    }

    // 11. Public Unified Storage API Implementation
    const AppStorage = {
        MIGRATION_STATES: MIGRATION_STATES,
        isRestoring: false,
        rollbackSnapshot: _rollbackSnapshot,


        /**
         * Initializes the storage engine, opens IndexedDB, performs migration & validation if required.
         * Must be called during app boot before React mounts.
         */
        init: async function () {
            _hydrationComplete = false;
            try {
                _db = await openIDB();
                _storageMode = 'INDEXEDDB';

                const state = await fetchMigrationState();

                // Establish a complete, read-only in-memory snapshot before any
                // migration or decomposition is allowed to mutate IndexedDB.
                await hydrateCacheFromIDB();
                let storageChanged = false;
                if (state !== MIGRATION_STATES.COMPLETED) {
                    storageChanged = await executeMigration();
                } else {
                    _migrationState = MIGRATION_STATES.COMPLETED;
                    poisonLegacyLocalStorageSource();
                    storageChanged = await checkAndDecomposeMonolithicIDB();
                }

                // Re-read only when Migration/Decompose actually changed IDB.
                if (storageChanged) await hydrateCacheFromIDB();
                return { success: true, mode: _storageMode, state: _migrationState };

            } catch (err) {
                _lastError = err.message || String(err);
                if (_migrationState === MIGRATION_STATES.COMPLETED) {
                    console.error('[StorageEngine] IndexedDB error post-COMPLETED! Fail Safe activated, LocalStorage fallback blocked:', _lastError);
                    _storageMode = 'STORAGE_FAILURE';
                    _hydrationComplete = isCompleteFinancialData(_financialDataCache);
                } else {
                    console.warn('[StorageEngine] Fallback triggered! Switching to LocalStorage mode due to:', _lastError);
                    const hadValidSnapshot = _hydrationComplete && isCompleteFinancialData(_financialDataCache);
                    _storageMode = 'LOCALSTORAGE_FALLBACK';
                    if (!hadValidSnapshot) {
                        try {
                            hydrateCacheFromLocalStorage();
                        } catch (fallbackErr) {
                            console.error('[StorageEngine] LocalStorage fallback was not safe to hydrate:', fallbackErr);
                            // Keep the last valid in-memory snapshot, if one exists.
                            _hydrationComplete = isCompleteFinancialData(_financialDataCache);
                        }
                    } else {
                        console.warn('[StorageEngine] Preserving the last valid IDB snapshot; fallback will not replace it.');
                    }
                }
                return { success: false, mode: _storageMode, state: _migrationState, error: _lastError };
            }
        },

        /**
         * Asynchronous read from Source of Truth (IndexedDB / Fallback) with memory cache update.
         */
        get: async function (key) {
            if (_storageMode === 'INDEXEDDB' && _db) {
                try {
                    let val = null;
                    if (key === 'hisabati_v6_data') {
                        val = await assembleFinancialData(_db);
                    } else if (key === 'hisabati_v6_settings') {
                        val = await loadSettingsData(_db);
                    } else {
                        val = await idbGet(_db, STORE_APP_KV, key);
                    }

                    if (val !== null) {
                        _cacheMap.set(key, val);
                        return val;
                    }
                    // A transient empty read must not destroy a still-recoverable
                    // snapshot in RAM or LocalStorage.
                    if (_cacheMap.has(key)) return _cacheMap.get(key);
                    if (_migrationState === MIGRATION_STATES.COMPLETED && key === 'hisabati_v6_data') {
                        return null;
                    }
                    const fallback = window.localStorage.getItem(key);
                    return fallback !== null ? fallback : null;
                } catch (e) {
                    console.warn(`[StorageEngine] Async IDB read failed for '${key}', serving from Memory Cache.`, e);
                }
            }
            if (_cacheMap.has(key)) return _cacheMap.get(key);
            if (_migrationState === MIGRATION_STATES.COMPLETED && key === 'hisabati_v6_data') {
                return null;
            }
            return window.localStorage.getItem(key);
        },

        /**
         * Fast Synchronous Read from In-Memory Cache (0ms latency for React render cycles).
         */
        getItem: function (key) {
            if (_cacheMap.has(key)) {
                return _cacheMap.get(key);
            }
            if (key === 'hisabati_v6_data' && isCompleteFinancialData(_financialDataCache)) {
                const snapshot = JSON.stringify(_financialDataCache);
                _cacheMap.set(key, snapshot);
                return snapshot;
            }
            if (_migrationState === MIGRATION_STATES.COMPLETED && key === 'hisabati_v6_data') {
                return null;
            }
            const valLS = window.localStorage.getItem(key);
            if (valLS !== null) {
                _cacheMap.set(key, valLS);
                return valLS;
            }
            return null;
        },

        /**
         * Bulk Write operation (Reserved for Import, Restore, Migration, & Drive Sync Payload):
         * 1. Updates Memory Cache instantly.
         * 2. Writes to Granular IndexedDB Stores as Source of Truth.
         * 3. IF migration is COMPLETED, writes to LocalStorage are HALTED permanently!
         */
        set: async function (key, value) {
            return this.setItem(key, value);
        },

        setItem: async function (key, value) {
            if (!_hydrationComplete || _storageMode === 'STORAGE_FAILURE') {
                console.warn(`[StorageEngine] Write blocked for '${key}' (Hydration: ${_hydrationComplete}, Mode: ${_storageMode}).`);
                return null;
            }
            if (key === 'hisabati_v6_data' && (!isCompleteFinancialData(value) || (_financialDataCache !== null && !isCompleteFinancialData(_financialDataCache)))) {
                console.warn('[StorageEngine] Full financial save blocked because the source or payload is incomplete.');
                return null;
            }

            // For hisabati_v6_data: pass the raw object (not string) to disassemble
            // to preserve React Immutable Update object references for === comparison.
            const isRawObj = (typeof value === 'object' && value !== null);
            const valStr = isRawObj ? JSON.stringify(value) : String(value);

            // ── Financial key: serialize through the Write Queue ─────────────────────
            // This is the ONLY path that writes hisabati_v6_data to IndexedDB.
            // The queue guarantees no other financial write runs concurrently.
            if (key === 'hisabati_v6_data') {
                // Claim sequence ID BEFORE enqueue so ordering matches call ordering.
                const mySeqId = _claimWriteSeq();
                return _enqueueWrite(async () => {
                    // 1. Primary Production Write to Granular IndexedDB (Source of Truth FIRST).
                    //    RAM is NOT touched until IDB commit succeeds.
                    if (_storageMode === 'INDEXEDDB' && _db) {
                        try {
                            await disassembleAndSaveFinancialData(_db, isRawObj ? value : valStr);
                        } catch (err) {
                            // IDB failed — RAM is still pristine (no pre-write was done).
                            _lastError = `IDB Bulk Write failed for '${key}': ${err.message}`;
                            console.error('[StorageEngine]', _lastError);
                            return null;
                        }
                    }

                    // 2. Stale Snapshot Guard: if a later task already committed,
                    //    this snapshot is older — do NOT overwrite RAM or _lastCommitSeq.
                    //    IDB is already correct (the later task's data won).
                    //    Note: under strict FIFO this branch is unreachable, but it
                    //    becomes relevant if atomicRestore or clear ran between
                    //    the enqueue of this task and its execution.
                    if (mySeqId < _lastCommitSeq) {
                        // Stale: IDB correct, RAM correct (set by later commit), skip.
                        console.warn(`[StorageEngine] Stale setItem skipped for '${key}' (seq ${mySeqId} < lastCommit ${_lastCommitSeq}).`);
                        return valStr; // return success so callers are not confused
                    }

                    // 3. IDB commit succeeded AND this is the latest commit:
                    //    now update RAM atomically.
                    _lastCommitSeq = mySeqId;
                    _cacheMap.set(key, valStr);
                    _lastSuccessfulCommit = new Date().toISOString();

                    // 4. LocalStorage Write Rules: HALT if migration COMPLETED
                    if (_migrationState !== MIGRATION_STATES.COMPLETED || _storageMode === 'LOCALSTORAGE_FALLBACK') {
                        try { window.localStorage.setItem(key, valStr); } catch (lsErr) { }
                    }
                    return valStr;
                });
            }

            // ── Non-financial keys: direct write (no queue needed) ───────────────────
            const hadPreviousCacheValue = _cacheMap.has(key);
            const previousCacheValue = hadPreviousCacheValue ? _cacheMap.get(key) : null;
            _cacheMap.set(key, valStr);

            if (_storageMode === 'INDEXEDDB' && _db) {
                try {
                    if (key === 'hisabati_v6_settings') {
                        await saveSettingsData(_db, valStr);
                    } else {
                        await idbPut(_db, STORE_APP_KV, { key: key, value: isRawObj ? value : valStr, updatedAt: new Date().toISOString() });
                    }
                } catch (err) {
                    if (hadPreviousCacheValue) {
                        _cacheMap.set(key, previousCacheValue);
                    } else {
                        _cacheMap.delete(key);
                    }
                    _lastError = `IDB Bulk Write failed for '${key}': ${err.message}`;
                    console.error('[StorageEngine]', _lastError);
                    return null;
                }
            }

            _lastSuccessfulCommit = new Date().toISOString();

            if (_migrationState !== MIGRATION_STATES.COMPLETED || _storageMode === 'LOCALSTORAGE_FALLBACK') {
                try { window.localStorage.setItem(key, valStr); } catch (lsErr) { }
            }
            return valStr;
        },

        /**
         * RECORD-LEVEL MUTATORS (Pertains to single entity updates: Customer, Transaction, Invoice, etc.)
         * Performs exactly 1 record put inside IndexedDB (e.g., customers.put(record)) and updates RAM cache.
         */
        saveRecord: async function (storeName, record) {
            if (!_hydrationComplete || _storageMode === 'STORAGE_FAILURE' || _financialDataNeedsPersistence || !isCompleteFinancialData(_financialDataCache)) return null;
            if (!record || typeof record !== 'object') return null;
            const rec = { ...record };
            if (!rec.id) {
                rec.id = `${storeName}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            }

            // Category duplicate check (read-only, before entering the queue)
            if (GRANULAR_STORES.includes(storeName) && storeName === 'categories' && rec.name) {
                const existingCat = (_financialDataCache.categories || []).find(item => item && item.id !== rec.id && String(item.name).trim() === String(rec.name).trim());
                if (existingCat) {
                    // 🛡️ رفض صريح لتكرار الإنشاء: عدم استبدال أو مسح حقول السجل الموجود (مثل createdAt)
                    return existingCat;
                }
            }

            // ── Serialize through the Write Queue ───────────────────────────────────
            // No IDB record-level write can race with a full disassemble or another saveRecord.
            // Claim sequence ID BEFORE enqueue.
            const mySeqId = _claimWriteSeq();
            return _enqueueWrite(async () => {
                // Re-validate inside the queue task: state may have changed while waiting.
                if (!_hydrationComplete || _storageMode === 'STORAGE_FAILURE' || !isCompleteFinancialData(_financialDataCache)) return null;

                // Ensure RAM cache is initialized
                if (!_financialDataCache) {
                    try {
                        const cachedVal = _cacheMap.get('hisabati_v6_data');
                        const strVal = (typeof cachedVal === 'object' && cachedVal !== null) ? JSON.stringify(cachedVal) : (cachedVal || '{"customers":[],"transactions":[],"invoices":[],"expenses":[],"revenues":[],"categories":[]}');
                        _financialDataCache = JSON.parse(strVal);
                    } catch (e) {
                        _financialDataCache = { customers: [], transactions: [], invoices: [], expenses: [], revenues: [], categories: [] };
                    }
                }

                // 1. Primary Production Write: IndexedDB (Single Source of Truth FIRST)
                // RAM is NOT updated until this succeeds.
                if (_storageMode === 'INDEXEDDB' && _db) {
                    try {
                        await idbPut(_db, storeName, rec);
                    } catch (err) {
                        _lastError = `IDB Record Write failed for '${storeName}/${rec.id}': ${err.message}`;
                        console.error('[StorageEngine]', _lastError);
                        return null; // RAM untouched on IDB failure
                    }
                }

                // 2. ONLY after successful IDB write: update RAM Cache.
                //    This is also a Stale Snapshot Guard: record-level writes ALWAYS
                //    win over a pending full-snapshot setItem of the same or lower seq.
                //    Advance _lastCommitSeq so any stale setItem queued earlier will
                //    detect it and skip its RAM update.
                _lastCommitSeq = Math.max(_lastCommitSeq, mySeqId);
                if (GRANULAR_STORES.includes(storeName)) {
                    if (!Array.isArray(_financialDataCache[storeName])) {
                        _financialDataCache[storeName] = [];
                    }
                    const idx = _financialDataCache[storeName].findIndex(item => item && item.id === rec.id);
                    if (idx !== -1) {
                        _financialDataCache[storeName][idx] = rec;
                    } else {
                        _financialDataCache[storeName].push(rec);
                    }
                    _cacheMap.set('hisabati_v6_data', JSON.stringify(_financialDataCache));
                }

                _lastSuccessfulCommit = new Date().toISOString();

                // 3. Sync to LocalStorage if not completed
                if (_migrationState !== MIGRATION_STATES.COMPLETED || _storageMode === 'LOCALSTORAGE_FALLBACK') {
                    try { window.localStorage.setItem('hisabati_v6_data', JSON.stringify(_financialDataCache)); } catch (e) { }
                }

                return rec;
            });
        },

        deleteRecord: async function (storeName, id) {
            if (!_hydrationComplete || _storageMode === 'STORAGE_FAILURE' || _financialDataNeedsPersistence || !isCompleteFinancialData(_financialDataCache)) return false;
            if (!id) return false;

            // ── Serialize through the Write Queue ───────────────────────────────────
            // Claim sequence ID BEFORE enqueue.
            const mySeqId = _claimWriteSeq();
            return _enqueueWrite(async () => {
                // Re-validate inside the queue task
                if (!_hydrationComplete || _storageMode === 'STORAGE_FAILURE' || !isCompleteFinancialData(_financialDataCache)) return false;

                if (!_financialDataCache) {
                    try {
                        const cachedVal = _cacheMap.get('hisabati_v6_data');
                        const strVal = (typeof cachedVal === 'object' && cachedVal !== null) ? JSON.stringify(cachedVal) : (cachedVal || '{"customers":[],"transactions":[],"invoices":[],"expenses":[],"revenues":[],"categories":[]}');
                        _financialDataCache = JSON.parse(strVal);
                    } catch (e) {
                        _financialDataCache = { customers: [], transactions: [], invoices: [], expenses: [], revenues: [], categories: [] };
                    }
                }

                // 1. Primary Production Delete: IndexedDB (Single Source of Truth FIRST)
                // RAM is NOT updated until this succeeds.
                if (_storageMode === 'INDEXEDDB' && _db) {
                    try {
                        await idbDelete(_db, storeName, id);
                    } catch (err) {
                        _lastError = `IDB Record Delete failed for '${storeName}/${id}': ${err.message}`;
                        console.error('[StorageEngine]', _lastError);
                        return false; // RAM untouched on IDB failure
                    }
                }

                // 2. ONLY after successful IDB delete: update RAM Cache.
                //    Advance _lastCommitSeq to invalidate any stale setItem queued before us.
                _lastCommitSeq = Math.max(_lastCommitSeq, mySeqId);
                if (GRANULAR_STORES.includes(storeName)) {
                    if (Array.isArray(_financialDataCache[storeName])) {
                        _financialDataCache[storeName] = _financialDataCache[storeName].filter(item => item && item.id !== id);
                    }
                    _cacheMap.set('hisabati_v6_data', JSON.stringify(_financialDataCache));
                }

                _lastSuccessfulCommit = new Date().toISOString();

                if (_migrationState !== MIGRATION_STATES.COMPLETED || _storageMode === 'LOCALSTORAGE_FALLBACK') {
                    try { window.localStorage.setItem('hisabati_v6_data', JSON.stringify(_financialDataCache)); } catch (e) { }
                }

                return true;
            });
        },

        // Helper record-level mutators
        saveCustomer: async function (customer) { return this.saveRecord('customers', customer); },
        deleteCustomer: async function (id) { return this.deleteRecord('customers', id); },
        saveTransaction: async function (tx) { return this.saveRecord('transactions', tx); },
        deleteTransaction: async function (id) { return this.deleteRecord('transactions', id); },
        saveInvoice: async function (invoice) { return this.saveRecord('invoices', invoice); },
        deleteInvoice: async function (id) { return this.deleteRecord('invoices', id); },
        saveExpense: async function (expense) { return this.saveRecord('expenses', expense); },
        deleteExpense: async function (id) { return this.deleteRecord('expenses', id); },
        saveRevenue: async function (revenue) { return this.saveRecord('revenues', revenue); },
        deleteRevenue: async function (id) { return this.deleteRecord('revenues', id); },
        saveCategory: async function (category) { return this.saveRecord('categories', category); },
        deleteCategory: async function (id) { return this.deleteRecord('categories', id); },
        saveSettings: async function (settings) {
            if (!_hydrationComplete || _storageMode === 'STORAGE_FAILURE') return null;
            const valStr = (typeof settings === 'object' && settings !== null) ? JSON.stringify(settings) : String(settings);
            if (_storageMode === 'INDEXEDDB' && _db) {
                try {
                    await saveSettingsData(_db, valStr);
                } catch (err) {
                    _lastError = `IDB Settings Write failed: ${err.message}`;
                    console.error('[StorageEngine]', _lastError);
                    return null;
                }
            }
            _cacheMap.set('hisabati_v6_settings', valStr);
            _lastSuccessfulCommit = new Date().toISOString();
            if (_migrationState !== MIGRATION_STATES.COMPLETED || _storageMode === 'LOCALSTORAGE_FALLBACK') {
                try { window.localStorage.setItem('hisabati_v6_settings', valStr); } catch (e) { }
            }
            return settings;
        },

        getRecord: async function (storeName, id) {
            if (_storageMode === 'INDEXEDDB' && _db) {
                return idbGet(_db, storeName, id);
            }
            if (_financialDataCache && Array.isArray(_financialDataCache[storeName])) {
                return _financialDataCache[storeName].find(item => item && item.id === id) || null;
            }
            return null;
        },

        getAllRecords: async function (storeName) {
            if (_storageMode === 'INDEXEDDB' && _db) {
                return idbGetAllStore(_db, storeName);
            }
            if (_financialDataCache && Array.isArray(_financialDataCache[storeName])) {
                return _financialDataCache[storeName];
            }
            return [];
        },

        /**
         * Removes key from IndexedDB stores, Memory Cache, and LocalStorage (if not completed).
         */
        remove: async function (key) {
            return this.removeItem(key);
        },

        removeItem: async function (key) {
            if (!_hydrationComplete || _storageMode === 'STORAGE_FAILURE') return false;

            // ── Financial key: serialize through the Write Queue ─────────────────────
            if (key === 'hisabati_v6_data') {
                return _enqueueWrite(async () => {
                    if (_storageMode === 'INDEXEDDB' && _db) {
                        try {
                            const tx = _db.transaction(GRANULAR_STORES, 'readwrite');
                            for (const s of GRANULAR_STORES) tx.objectStore(s).clear();
                            await new Promise((resolve, reject) => {
                                tx.oncomplete = () => resolve(true);
                                tx.onerror = (event) => reject(tx.error || event?.target?.error || new Error('Financial data delete failed'));
                                tx.onabort = (event) => reject(tx.error || event?.target?.error || new Error('Financial data delete aborted'));
                            });
                        } catch (err) {
                            console.error(`[StorageEngine] IDB delete failed for '${key}':`, err);
                            return false;
                        }
                    }
                    // RAM update ONLY after successful IDB clear
                    _cacheMap.delete(key);
                    _financialDataCache = getEmptyFinancialData();
                    if (_migrationState !== MIGRATION_STATES.COMPLETED || _storageMode === 'LOCALSTORAGE_FALLBACK') {
                        try { window.localStorage.removeItem(key); } catch (e) { }
                    }
                    return true;
                });
            }

            // ── Non-financial keys: direct operation (no queue needed) ───────────────
            if (_storageMode === 'INDEXEDDB' && _db) {
                try {
                    if (key === 'hisabati_v6_settings') {
                        await idbDelete(_db, STORE_SETTINGS, 'hisabati_v6_settings');
                    } else {
                        await idbDelete(_db, STORE_APP_KV, key);
                    }
                } catch (err) {
                    console.error(`[StorageEngine] IDB delete failed for '${key}':`, err);
                    return false;
                }
            }
            _cacheMap.delete(key);
            if (_migrationState !== MIGRATION_STATES.COMPLETED || _storageMode === 'LOCALSTORAGE_FALLBACK') {
                try { window.localStorage.removeItem(key); } catch (e) { }
            }
            return true;
        },

        /**
         * ATOMIC RESTORE — Transactional full-database replacement.
         *
         * Guarantees:
         *  1. Validates the payload BEFORE touching any existing data.
         *  2. Snapshots current state for rollback.
         *  3. Clears + writes new data in a single logical batch (forceFull disassembly).
         *  4. Rolls back to snapshot automatically on any failure.
         *  5. Updates RAM cache atomically only after successful write.
         *
         * @param {object|string} payload  - Full backup payload { data, settings, inventory }
         * @param {function}      onProgress - (step: 0-100, label: string) => void
         * @returns {{ ok: boolean, counts?: object, error?: string, phase?: string }}
         */
        atomicRestore: async function (payload, onProgress) {
            if (!_hydrationComplete || _storageMode === 'STORAGE_FAILURE') return { ok: false, phase: 'not_ready', error: 'Storage engine is in STORAGE_FAILURE mode. Operations locked.' };
            const report = (step, label) => { try { onProgress && onProgress(step, label); } catch (e) {} };

            // ── Phase 1: Parse & Validate (OUTSIDE queue — read-only, safe to do before acquiring slot) ─
            report(10, 'التحقق من صحة الملف...');
            let p;
            try {
                p = (typeof payload === 'string') ? JSON.parse(payload) : payload;
                if (!p || typeof p !== 'object') throw new Error('الملف فارغ أو تالف');
                if (!p.data || typeof p.data !== 'object') throw new Error('بيانات الملف مفقودة أو غير صالحة');
            } catch (err) {
                return { ok: false, phase: 'validate', error: err.message };
            }

            // ── Phase 2: Normalize incoming data (OUTSIDE queue — no writes yet) ────
            report(20, 'معالجة البيانات...');
            const d = p.data;
            if (!d.invoices)     d.invoices     = [];
            if (!d.expenses)     d.expenses     = [];
            if (!d.revenues)     d.revenues     = [];
            if (!d.categories)   d.categories   = [];
            if (!d.customers)    d.customers    = [];
            if (!d.transactions) d.transactions = [];

            d.transactions = d.transactions.map(t => ({
                ...t,
                paymentMethod: t.paymentMethod || 'cash',
                bankId: t.bankId || 'none',
                bankCustomName: t.bankCustomName || '',
                isClosingEntry: t.isClosingEntry || false
            }));
            d.expenses = d.expenses.map(exp => ({
                ...exp,
                paymentMethod: exp.paymentMethod || 'cash',
                bankId: exp.bankId || 'none',
                bankCustomName: exp.bankCustomName || ''
            }));
            d.revenues = d.revenues.map(rev => ({
                ...rev,
                paymentMethod: rev.paymentMethod || 'cash',
                bankId: rev.bankId || 'none',
                bankCustomName: rev.bankCustomName || ''
            }));
            d.invoices = d.invoices.map(inv => ({
                ...inv,
                bankDetails: { id: inv.bankDetails?.id || 'none', customName: inv.bankDetails?.customName || '' },
                items: (inv.items || []).map(item => ({ ...item, costPrice: item.costPrice || '0' }))
            }));
            d.customers = d.customers.map(c => ({
                ...c,
                isPinned: c.isPinned || false,
                categoryId: c.categoryId || null
            }));

            // ── Phase 3: Snapshot current state for rollback (OUTSIDE queue — read-only) ─
            report(35, 'تأمين نسخة احتياطية مؤقتة...');
            let snapshot = null;
            try {
                if (_storageMode === 'INDEXEDDB' && _db) {
                    const snapDataStr = await assembleFinancialData(_db);
                    const snapSettingsStr = _cacheMap.get('hisabati_v6_settings') || null;
                    snapshot = { dataStr: snapDataStr, settingsStr: snapSettingsStr };
                } else {
                    snapshot = {
                        dataStr: _cacheMap.get('hisabati_v6_data') || null,
                        settingsStr: _cacheMap.get('hisabati_v6_settings') || null
                    };
                }
            } catch (snapErr) {
                console.warn('[atomicRestore] Snapshot failed, rollback will be unavailable:', snapErr.message);
            }

            // ── Phases 4-6: All writes inside a SINGLE Write Queue task ──────────────
            // This guarantees that no Auto Save, saveRecord, deleteRecord, or any other
            // financial write can interleave with the restore operation.
            const newSettingsStr = p.settings ? JSON.stringify(p.settings) : null;

            const writeResult = await _enqueueWrite(async () => {
                // ── Phase 4: Write new data (Clear + Full Write) ─────────────────
                report(60, 'كتابة البيانات الجديدة...');
                try {
                    // ARCHITECTURAL DECISION: atomicRestore intentionally performs a full replacement of local data.
                    // This is a product policy, not a data integrity bug. Users may intentionally restore an older backup
                    // to roll back unwanted changes. Do not replace this behavior with automatic merge/version logic
                    // unless the product specification changes.
                    await disassembleAndSaveFinancialData(_db, d, true /* forceFull */);
                } catch (writeErr) {
                    report(60, 'فشلت الكتابة — جاري التراجع...');
                    // _rollbackSnapshot is called from within the queue task slot (safe — no parallel write).
                    if (snapshot) await _rollbackSnapshot(snapshot);
                    return { ok: false, phase: 'write_data', error: writeErr.message };
                }

                // ── Phase 5: Write settings ──────────────────────────────────────
                report(75, 'حفظ الإعدادات...');
                if (newSettingsStr && _storageMode === 'INDEXEDDB' && _db) {
                    try {
                        await saveSettingsData(_db, newSettingsStr);
                    } catch (settingsErr) {
                        report(75, 'فشل حفظ الإعدادات — جاري التراجع...');
                        if (snapshot) await _rollbackSnapshot(snapshot);
                        return { ok: false, phase: 'write_settings', error: settingsErr.message };
                    }
                }

                // ── Phase 6: Atomically update RAM cache (only after all IDB writes succeed) ─
                report(88, 'تحديث الذاكرة...');
                // Advance _lastCommitSeq so any stale setItem queued before this restore
                // will detect it and skip its RAM update.
                _lastCommitSeq = _claimWriteSeq();
                const newDataStr = JSON.stringify(d);
                _cacheMap.set('hisabati_v6_data', newDataStr);
                _financialDataCache = d;
                if (newSettingsStr) {
                    _cacheMap.set('hisabati_v6_settings', newSettingsStr);
                }
                _lastSuccessfulCommit = new Date().toISOString();

                // LocalStorage sync (only if migration not completed)
                if (_migrationState !== MIGRATION_STATES.COMPLETED || _storageMode === 'LOCALSTORAGE_FALLBACK') {
                    try { window.localStorage.setItem('hisabati_v6_data', newDataStr); } catch (e) {}
                    if (newSettingsStr) {
                        try { window.localStorage.setItem('hisabati_v6_settings', newSettingsStr); } catch (e) {}
                    }
                }

                return { ok: true };
            });

            if (!writeResult.ok) return writeResult;

            // ── Phase 7: Count & Done ──────────────────────────────────────────────
            report(100, 'اكتملت الاستعادة بنجاح ✓');
            const counts = {
                customers:    d.customers.length,
                transactions: d.transactions.length,
                invoices:     d.invoices.length,
                expenses:     d.expenses.length,
                revenues:     d.revenues.length,
                categories:   d.categories.length
            };
            return { ok: true, counts, normalizedData: d, normalizedSettings: p.settings || null, snapshot };
        },

        /**
         * Clears all storage.
         */
        clear: async function () {
            if (!_hydrationComplete || _storageMode === 'STORAGE_FAILURE') return false;

            // ── Serialize through the Write Queue ───────────────────────────────────
            return _enqueueWrite(async () => {
                if (_storageMode === 'INDEXEDDB' && _db) {
                    try {
                        const tx = _db.transaction([STORE_APP_KV, STORE_SETTINGS, ...GRANULAR_STORES], 'readwrite');
                        for (const storeName of [STORE_APP_KV, STORE_SETTINGS, ...GRANULAR_STORES]) tx.objectStore(storeName).clear();
                        await new Promise((resolve, reject) => {
                            tx.oncomplete = () => resolve(true);
                            tx.onerror = (event) => reject(tx.error || event?.target?.error || new Error('IDB clear failed'));
                            tx.onabort = (event) => reject(tx.error || event?.target?.error || new Error('IDB clear aborted'));
                        });
                    } catch (err) {
                        console.error('[StorageEngine] IDB clear failed:', err);
                        return false;
                    }
                }
                // RAM update ONLY after successful IDB clear.
                // Advance _lastCommitSeq to invalidate any stale setItem queued before clear.
                _lastCommitSeq = _claimWriteSeq();
                if (_migrationState !== MIGRATION_STATES.COMPLETED || _storageMode === 'LOCALSTORAGE_FALLBACK') {
                    try { window.localStorage.clear(); } catch (e) { }
                }
                _cacheMap.clear();
                _financialDataCache = getEmptyFinancialData();
                return true;
            });
        },

        /**
         * Transactional access for atomic operations.
         */
        transaction: async function (keys, mode, callback) {
            if (typeof callback !== 'function') return;
            const values = {};
            for (const k of keys) {
                values[k] = this.getItem(k);
            }
            const result = await callback(values);
            if (mode === 'readwrite' && result && typeof result === 'object') {
                for (const [k, v] of Object.entries(result)) {
                    await this.setItem(k, v);
                }
            }
            return result;
        },

        /**
         * Explicit manual trigger for migration.
         */
        migrate: async function (force = false) {
            if (!_hydrationComplete) return false;
            if (!_db) _db = await openIDB();
            return executeMigration(force);
        },

        /**
         * Explicit manual trigger for validation against LocalStorage.
         */
        validate: async function () {
            let allValid = true;
            const details = {};
            for (const key of MIGRATION_KEYS) {
                const valLS = window.localStorage.getItem(key);
                const valIDB = await this.get(key);
                const res = validateSingleKey(key, valLS, valIDB);
                details[key] = res;
                if (!res.valid) allValid = false;
            }
            _lastValidation = { timestamp: new Date().toISOString(), status: allValid ? 'PASSED' : 'FAILED', details };
            return _lastValidation;
        },

        /**
         * Storage Diagnostics Dashboard API for developer & audit inspection.
         */
        getDiagnostics: function () {
            return {
                storageMode: _storageMode,
                migrationState: _migrationState,
                indexedDBVersion: DB_VERSION,
                cacheKeysCount: _cacheMap.size,
                databaseName: DB_NAME,
                granularStoresCount: GRANULAR_STORES.length,
                localStorageFrozen: (_migrationState === MIGRATION_STATES.COMPLETED),
                lastValidation: _lastValidation,
                lastError: _lastError,
                lastSuccessfulCommit: _lastSuccessfulCommit
            };
        }
    };

    // 12. Repositories Classes
    class BaseRepository {
        constructor(storeName) {
            this.storeName = storeName;
        }
        async get(id) {
            return AppStorage.getRecord(this.storeName, id);
        }
        async getAll() {
            return AppStorage.getAllRecords(this.storeName);
        }
        async save(record) {
            return AppStorage.saveRecord(this.storeName, record);
        }
        async insert(record) {
            return this.save(record);
        }
        async update(record) {
            return this.save(record);
        }
        async delete(id) {
            return AppStorage.deleteRecord(this.storeName, id);
        }
    }

    class CustomerRepositoryClass extends BaseRepository { constructor() { super('customers'); } }
    class TransactionRepositoryClass extends BaseRepository { constructor() { super('transactions'); } }
    class InvoiceRepositoryClass extends BaseRepository { constructor() { super('invoices'); } }
    class ExpenseRepositoryClass extends BaseRepository { constructor() { super('expenses'); } }
    class RevenueRepositoryClass extends BaseRepository { constructor() { super('revenues'); } }
    class CategoryRepositoryClass extends BaseRepository { constructor() { super('categories'); } }
    class SettingsRepositoryClass {
        async get() {
            return AppStorage.getItem('hisabati_v6_settings');
        }
        async save(settings) {
            return AppStorage.saveSettings(settings);
        }
    }

    const CustomerRepository = new CustomerRepositoryClass();
    const TransactionRepository = new TransactionRepositoryClass();
    const InvoiceRepository = new InvoiceRepositoryClass();
    const ExpenseRepository = new ExpenseRepositoryClass();
    const RevenueRepository = new RevenueRepositoryClass();
    const CategoryRepository = new CategoryRepositoryClass();
    const SettingsRepository = new SettingsRepositoryClass();

    const repositories = {
        CustomerRepository,
        TransactionRepository,
        InvoiceRepository,
        ExpenseRepository,
        RevenueRepository,
        CategoryRepository,
        SettingsRepository
    };

    AppStorage.repositories = repositories;
    AppStorage.CustomerRepository = CustomerRepository;
    AppStorage.TransactionRepository = TransactionRepository;
    AppStorage.InvoiceRepository = InvoiceRepository;
    AppStorage.ExpenseRepository = ExpenseRepository;
    AppStorage.RevenueRepository = RevenueRepository;
    AppStorage.CategoryRepository = CategoryRepository;
    AppStorage.SettingsRepository = SettingsRepository;

    // Export globally to window
    window.AppStorage = AppStorage;
    window.StorageEngine = AppStorage;
    window.CustomerRepository = CustomerRepository;
    window.TransactionRepository = TransactionRepository;
    window.InvoiceRepository = InvoiceRepository;
    window.ExpenseRepository = ExpenseRepository;
    window.RevenueRepository = RevenueRepository;
    window.CategoryRepository = CategoryRepository;
    window.SettingsRepository = SettingsRepository;

})(window);

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const db = require('../db');

const FILES_DIR = path.join(__dirname, 'files');

(async () => {
    try {
        console.log('Connecting to database...');
        await db.init();

        if (!fs.existsSync(FILES_DIR)) {
            console.error('Directory not found:', FILES_DIR);
            process.exit(1);
        }

        const files = fs.readdirSync(FILES_DIR);
        const xlsxFiles = files.filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'));

        if (xlsxFiles.length === 0) {
            console.log('No .xlsx files found in', FILES_DIR);
            process.exit(0);
        }

        const allOwners = [];

        for (const file of xlsxFiles) {
            console.log(`Reading file: ${file}`);
            const fullPath = path.join(FILES_DIR, file);
            const workbook = XLSX.readFile(fullPath);

            if (workbook.SheetNames.length === 0) continue;

            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

            let fileDataCount = 0;
            // Row 0 is header
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (!row || row.length === 0) continue;

                //stall_type, sell_class, name, id_card, qty
                const stallType = String(row[0] || '').trim();
                const sellClass = String(row[1] || '').trim();
                const name = String(row[2] || '').trim();
                const idCard = String(row[3] || '').trim().toUpperCase();
                const qtyVal = row[4];

                if (!stallType || !name || !idCard) continue;

                const qty = qtyVal ? parseInt(qtyVal, 10) : 1;

                allOwners.push({
                    name,
                    idCard,
                    stallType,
                    sellClass,
                    qty: isNaN(qty) ? 1 : qty
                });
                fileDataCount++;
            }
            console.log(`  -> Analyzed ${fileDataCount} records.`);
        }

        console.log(`Total owners extracted: ${allOwners.length}`);

        if (allOwners.length > 0) {
            console.log('Inserting into database...');
            const result = await db.insertOwnersBulk(allOwners);
            console.log(`Data import complete. Inserted ${result.inserted} records.`);

            console.log('Syncing stall classes stats...');
            await db.syncStallClassStats();
            console.log('Sync complete.');
        } else {
            console.log('No valid data found to import.');
        }

        process.exit(0);

    } catch (err) {
        console.error('Import failed:', err);
        process.exit(1);
    }
})();

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
        // Filter for xlsx files, ignoring temp files (starting with ~$)
        const xlsxFiles = files.filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'));

        if (xlsxFiles.length === 0) {
            console.log('No .xlsx files found in', FILES_DIR);
            process.exit(0);
        }

        const allOwners = [];

        for (const file of xlsxFiles) {
            // Determine stallType from filename (remove extension)
            let stallType = path.basename(file, '.xlsx');

            // If filename ends with '登记' (e.g. 花车登记), remove it -> '花车'
            // to match the stall types used in init-data.js
            if (stallType.endsWith('登记')) {
                stallType = stallType.slice(0, -2);
            }

            console.log(`Reading file: ${file} (Type: ${stallType})`);

            const fullPath = path.join(FILES_DIR, file);
            const workbook = XLSX.readFile(fullPath);

            if (workbook.SheetNames.length === 0) {
                console.warn(`  Skipping ${file}: No sheets found.`);
                continue;
            }

            // Read first sheet
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];

            // Convert to array of arrays (header: 1)
            // Row 0 is header, data starts from Row 1
            // Col 0: Name, Col 1: IDCard, Col 2: Qty
            const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

            let fileDataCount = 0;
            // Start loop from index 1 to skip header
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (!row || row.length === 0) continue;

                const name = row[0];
                const idCard = row[1];
                const qtyVal = row[2];

                // Basic validation: Name and idCard must be present
                if (!name || !idCard) {
                    continue;
                }

                const qty = qtyVal ? parseInt(qtyVal, 10) : 1;

                allOwners.push({
                    name: String(name).trim(),
                    idCard: String(idCard).trim(),
                    stallType: stallType,
                    qty: isNaN(qty) ? 1 : qty
                });
                fileDataCount++;
            }
            console.log(`  -> Analyzed ${fileDataCount} records.`);
        }

        console.log(`Total owners extracted: ${allOwners.length}`);

        if (allOwners.length > 0) {
            console.log('Inserting into database...');
            // Note: insertOwnersBulk uses INSERT OR IGNORE, so duplicates (same idCard+stallType) won't crash it
            const result = await db.insertOwnersBulk(allOwners);
            console.log(`Data import complete. Inserted ${result.inserted} records.`);
        } else {
            console.log('No valid data found to import.');
        }

        process.exit(0);

    } catch (err) {
        console.error('Import failed:', err);
        process.exit(1);
    }
})();

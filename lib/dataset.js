const fs = require('fs');
const path = require('path');

class DatasetManager {
  constructor() {
    this.dataDir = path.join(__dirname, '..', 'data');
    this.datasets = new Map();

    this.ensureDataDir();
    this.loadAllDatasets();
  }

  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      console.log(`Folder data dibuat: ${this.dataDir}`);
    }
  }

  parseCsvLine(line) {
    const values = [];
    let current = '';
    let insideQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (insideQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          insideQuotes = !insideQuotes;
        }
        continue;
      }

      if (char === ',' && !insideQuotes) {
        values.push(current.trim());
        current = '';
        continue;
      }

      current += char;
    }

    values.push(current.trim());
    return values;
  }

  buildTextFromCsvRow(headers, row) {
    const fields = [];

    headers.forEach((header, index) => {
      const value = row[index] ? row[index].trim() : '';

      if (!value) return;

      fields.push(`${header}: ${value}`);
    });

    return fields.join('\n');
  }

  extractCsvLabel(row) {
    for (const value of row) {
      const cleanValue = value ? value.trim() : '';

      if (!cleanValue) continue;
      if (/^https?:\/\//i.test(cleanValue)) continue;
      if (cleanValue.length < 4) continue;

      return cleanValue.slice(0, 60);
    }

    return 'produk';
  }

  loadCsvDataset(filePath, datasetName) {
    const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');

    const lines = content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    if (lines.length < 2) {
      return {
        name: datasetName,
        file: filePath,
        data: { documents: [] },
        loadedAt: new Date().toISOString()
      };
    }

    const headers = this.parseCsvLine(lines[0]);
    const documents = [];

    for (let i = 1; i < lines.length; i++) {
      const row = this.parseCsvLine(lines[i]);
      const text = this.buildTextFromCsvRow(headers, row);

      if (!text) continue;

      const title = this.extractCsvLabel(row);

      documents.push({
        source: `${datasetName}/${title}`,
        text
      });
    }

    return {
      name: datasetName,
      file: filePath,
      data: {
        metadata: {
          name: datasetName,
          type: 'csv'
        },
        documents
      },
      loadedAt: new Date().toISOString()
    };
  }

  loadAllDatasets() {
    try {
      const files = fs.readdirSync(this.dataDir);

      for (const file of files) {
        const filePath = path.join(this.dataDir, file);

        if (file.endsWith('.csv')) {
          const datasetName = file.replace('.csv', '');
          const dataset = this.loadCsvDataset(filePath, datasetName);

          this.datasets.set(datasetName, dataset);
          console.log(`Dataset CSV berhasil dimuat: ${datasetName}`);
        }

        if (file.endsWith('.json')) {
          const datasetName = file.replace('.json', '');
          const content = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(content);

          this.datasets.set(datasetName, {
            name: datasetName,
            file: filePath,
            data,
            loadedAt: new Date().toISOString()
          });

          console.log(`Dataset JSON berhasil dimuat: ${datasetName}`);
        }
      }

      if (this.datasets.size === 0) {
        console.log('Belum ada dataset di folder data.');
      }
    } catch (error) {
      console.error('Gagal memuat dataset:', error.message);
    }
  }

  getAllDocuments() {
    const allDocs = [];

    for (const [name, dataset] of this.datasets) {
      if (dataset.data.documents && Array.isArray(dataset.data.documents)) {
        for (const doc of dataset.data.documents) {
          allDocs.push({
            source: `${name}/${doc.source || 'unknown'}`,
            text: doc.text || ''
          });
        }
      }
    }

    return allDocs;
  }

  listDatasets() {
    return Array.from(this.datasets.values()).map(dataset => ({
      name: dataset.name,
      loadedAt: dataset.loadedAt,
      documentCount: dataset.data.documents ? dataset.data.documents.length : 0
    }));
  }
}

module.exports = DatasetManager;
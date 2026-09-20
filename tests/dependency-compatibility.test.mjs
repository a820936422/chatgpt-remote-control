import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const commanderRequire = createRequire(new URL('../node_modules/@wonderwhy-er/desktop-commander/package.json', import.meta.url));

test('patched sharp supports the bridge and Desktop Commander image pipelines', async () => {
  const upstreamSharp = commanderRequire('sharp');
  const image = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#268bd2' } }).png().toBuffer();
  const converted = await upstreamSharp(image).resize({ width: 32 }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  const metadata = await sharp(converted).metadata();
  assert.equal(metadata.width, 32);
  assert.equal(metadata.height, 16);
  assert.equal(metadata.format, 'jpeg');
});

test('ExcelJS retains spreadsheet write/read and conditional formatting with patched uuid', async () => {
  const ExcelJS = commanderRequire('exceljs');
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('验证');
  sheet.addRows([['中文', 1], ['text', 2]]);
  sheet.addConditionalFormatting({ ref: 'B1:B2', rules: [{ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF0088FF' } }] });
  const bytes = await book.xlsx.writeBuffer();
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  assert.equal(restored.getWorksheet('验证').getCell('A1').value, '中文');
  assert.equal(restored.getWorksheet('验证').getCell('B2').value, 2);
});

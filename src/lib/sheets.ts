import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { AppError } from "./policy";
export function safeCsv(value: unknown) {
  let s = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function guardSpreadsheetArchive(bytes: Buffer) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new AppError(400, "올바른 XLSX ZIP 구조가 아닙니다.");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16),
    expanded = 0;
  if (count > 2000 || count === 65535)
    throw new AppError(400, "압축 항목이 너무 많습니다.");
  for (let n = 0; n < count; n++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new AppError(400, "손상된 XLSX 파일입니다.");
    const size = bytes.readUInt32LE(offset + 24);
    expanded += size;
    if (size === 0xffffffff || expanded > 32 * 1024 * 1024)
      throw new AppError(413, "압축 해제 용량은 32MB 이하로 제한됩니다.");
    offset +=
      46 +
      bytes.readUInt16LE(offset + 28) +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
  }
}
export async function parseSheet(
  file: File,
): Promise<Record<string, string>[]> {
  if (file.size > 5 * 1024 * 1024)
    throw new AppError(413, "가져오기 파일은 5MB 이하로 선택해 주세요.");
  const workbook = new ExcelJS.Workbook();
  const bytes = Buffer.from(await file.arrayBuffer());
  let sheet: ExcelJS.Worksheet | undefined;
  if (file.name.toLowerCase().endsWith(".xlsx")) {
    guardSpreadsheetArchive(bytes);
    try {
      await workbook.xlsx.load(bytes as any);
    } catch {
      throw new AppError(400, "XLSX 내용을 읽을 수 없습니다.");
    }
    sheet = workbook.worksheets[0];
  } else if (file.name.toLowerCase().endsWith(".csv"))
    sheet = await workbook.csv.read(Readable.from(bytes));
  else throw new AppError(400, "XLSX 또는 CSV 파일을 선택해 주세요.");
  if (!sheet || sheet.rowCount < 2)
    throw new AppError(400, "머리글과 데이터 행이 필요합니다.");
  if (sheet.rowCount > 1001)
    throw new AppError(400, "한 번에 1,000행까지 가져올 수 있습니다.");
  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell, i) => {
    headers[i] = cell.text.trim();
  });
  const rows: Record<string, string>[] = [];
  for (let n = 2; n <= sheet.rowCount; n++) {
    const row: Record<string, string> = {};
    for (let i = 1; i < headers.length; i++)
      if (headers[i]) row[headers[i]] = sheet.getRow(n).getCell(i).text.trim();
    if (Object.values(row).some(Boolean)) rows.push(row);
  }
  return rows;
}
export async function workbookBytes(
  rows: Record<string, any>[],
  columns: [string, string][],
) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Operix");
  ws.columns = columns.map(([key, header]) => ({ key, header, width: 24 }));
  for (const row of rows) ws.addRow(row);
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF16634B" },
  };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

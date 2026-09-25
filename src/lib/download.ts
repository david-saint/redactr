/**
 * Build the download name for a redacted file, e.g. `scan.pdf` → `scan-redacted.pdf`,
 * or with a suffix `scan.pdf` → `scan-page-2-redacted.png`.
 */
export function redactedFileName(
  originalName: string,
  extension: string,
  suffix = ''
): string {
  const baseName = originalName.replace(/\.[^.]+$/, '') || 'image';
  return `${baseName}${suffix}-redacted.${extension}`;
}

/** Trigger a browser download of `blob`. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // Revoking synchronously can abort large downloads in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

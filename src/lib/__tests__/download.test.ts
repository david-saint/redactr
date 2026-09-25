import { describe, it, expect } from 'vitest';
import { redactedFileName } from '../download';

describe('redactedFileName', () => {
  it('should replace the extension and add a -redacted suffix', () => {
    expect(redactedFileName('photo.jpg', 'png')).toBe('photo-redacted.png');
    expect(redactedFileName('contract.final.pdf', 'pdf')).toBe(
      'contract.final-redacted.pdf'
    );
  });

  it('should insert an optional suffix before -redacted', () => {
    expect(redactedFileName('scan.pdf', 'png', '-page-3')).toBe(
      'scan-page-3-redacted.png'
    );
  });

  it('should fall back to a default name', () => {
    expect(redactedFileName('', 'png')).toBe('image-redacted.png');
  });
});

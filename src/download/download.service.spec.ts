import { HttpException } from '@nestjs/common';
import { DownloadService } from './download.service';

describe('DownloadService', () => {
  let service: DownloadService;

  beforeEach(() => {
    service = new DownloadService({
      get: (key: string) =>
        key === 'BASE_URL' ? 'https://download.example.com' : undefined,
    } as never);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('blocks private IPv4, IPv6 and IPv4-mapped IPv6 addresses', () => {
    const isBlockedIp = (service as any).isBlockedIp.bind(service);

    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('[::1]')).toBe(true);
    expect(isBlockedIp('[::ffff:7f00:1]')).toBe(true);
    expect(isBlockedIp('::ffff:192.168.1.1')).toBe(true);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
  });

  it('detects image type from the saved file signature', () => {
    const detectFileExtensionFromSignature = (
      service as any
    ).detectFileExtensionFromSignature.bind(service);
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    expect(detectFileExtensionFromSignature(pngHeader, 'image')).toBe('.png');
  });

  it('does not request compressed binary responses', () => {
    const getRequestHeaders = (service as any).getRequestHeaders.bind(service);
    const getAxiosRequestConfig = (service as any).getAxiosRequestConfig.bind(
      service,
    );

    expect(
      getRequestHeaders(new URL('https://example.com/image.jpg'), 'image'),
    ).not.toHaveProperty('Accept-Encoding');
    expect(
      getAxiosRequestConfig(
        new URL('https://example.com/image.jpg'),
        'image',
        1000,
      ),
    ).toMatchObject({ decompress: false });
  });

  it('rejects files whose content is not the requested media type', () => {
    const validateFileSignature = (service as any).validateFileSignature.bind(
      service,
    );

    expect(() =>
      validateFileSignature(Buffer.from('not an image'), 'image'),
    ).toThrow(HttpException);
  });
});

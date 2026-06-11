import { BadRequestException } from '@nestjs/common';
import { DownloadController } from './download.controller';
import { DownloadService } from './download.service';

describe('DownloadController', () => {
  let controller: DownloadController;
  let downloadService: { downloadFile: jest.Mock };

  beforeEach(() => {
    downloadService = {
      downloadFile: jest.fn().mockResolvedValue({
        url: 'https://download.example.com/images/file.png',
        size: 0.01,
      }),
    };
    controller = new DownloadController(
      downloadService as unknown as DownloadService,
    );
  });

  it('passes the URL through without decoding it again', async () => {
    const url = 'https://example.com/image.png?token=a%2Fb';

    await controller.downloadFile({
      url,
      name_prefix: 'wm_123',
      type: 'image',
    });

    expect(downloadService.downloadFile).toHaveBeenCalledWith(
      url,
      'wm_123',
      'image',
    );
  });

  it('uses the default name prefix when it is not provided', async () => {
    await controller.downloadFile({
      url: 'https://example.com/video.mp4',
      type: 'video',
    });

    expect(downloadService.downloadFile).toHaveBeenCalledWith(
      'https://example.com/video.mp4',
      '123456',
      'video',
    );
  });

  it('rejects unsupported media types', async () => {
    await expect(
      controller.downloadFile({
        url: 'https://example.com/image.png',
        type: 'file',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { DownloadService } from './download.service';

interface DownloadQueryDto {
  url?: unknown;
  name_prefix?: unknown;
  type?: unknown;
}

@Controller('download')
export class DownloadController {
  constructor(private readonly downloadService: DownloadService) {}

  @Get()
  async downloadFile(@Query() query: DownloadQueryDto) {
    const url = this.validateUrl(query.url);
    const name_prefix = this.validateNamePrefix(query.name_prefix);
    const type = this.validateType(query.type);

    const resData = await this.downloadService.downloadFile(
      url,
      name_prefix,
      type,
    );
    return { ...resData };
  }

  private getSingleQueryValue(value: unknown, fieldName: string): string {
    if (Array.isArray(value) || typeof value !== 'string') {
      throw new BadRequestException(`请提供有效的${fieldName}`);
    }

    const normalized = value.trim();
    if (!normalized) {
      throw new BadRequestException(`请提供有效的${fieldName}`);
    }
    return normalized;
  }

  private validateUrl(value: unknown): string {
    const url = this.getSingleQueryValue(value, 'URL');
    try {
      const parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('invalid protocol');
      }
      return url;
    } catch (error) {
      throw new BadRequestException('请提供有效的URL');
    }
  }

  private validateNamePrefix(value: unknown): string {
    if (value === undefined || value === null || value === '') {
      return '123456';
    }

    const namePrefix = this.getSingleQueryValue(value, '文件名前缀');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(namePrefix)) {
      throw new BadRequestException(
        '文件名前缀只能包含字母、数字、下划线和中划线',
      );
    }
    return namePrefix;
  }

  private validateType(value: unknown): 'video' | 'image' {
    const type = this.getSingleQueryValue(value, '类型');
    if (type !== 'video' && type !== 'image') {
      throw new BadRequestException('类型必须是 video 或 image');
    }
    return type;
  }
}

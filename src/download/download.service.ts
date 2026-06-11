import {
  Injectable,
  HttpException,
  HttpStatus,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import axios, { AxiosRequestConfig } from 'axios';
import * as dns from 'dns';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DownloadService implements OnModuleInit, OnModuleDestroy {
  private readonly MAX_VIDEO_SIZE_MB = 100;
  private readonly MAX_IMAGE_SIZE_MB = 10;
  private readonly SUPPORTED_VIDEO_FORMATS = [
    '.mp4',
    '.avi',
    '.mov',
    '.webm',
    '.mkv',
  ];
  private readonly SUPPORTED_IMAGE_FORMATS = [
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp',
  ];
  private readonly DELETE_AFTER_HOURS = 1;
  private readonly CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
  private readonly VALIDATE_TIMEOUT_MS = 10000;
  private readonly IMAGE_DOWNLOAD_TIMEOUT_MS = 15000;
  private readonly VIDEO_DOWNLOAD_TIMEOUT_MS = 55000;
  private readonly PUBLIC_SUB_DIRS = ['videos', 'images'];
  private readonly baseDirectory: string;
  private readonly downloadPath: string;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly httpAgent = new http.Agent({
    keepAlive: false,
    lookup: this.safeLookup.bind(this),
  });
  private readonly httpsAgent = new https.Agent({
    keepAlive: false,
    lookup: this.safeLookup.bind(this),
  });

  constructor(private configService: ConfigService) {
    const baseUrl = this.configService.get<string>('BASE_URL');
    if (!baseUrl) {
      throw new Error('BASE_URL configuration is missing');
    }
    this.downloadPath = baseUrl;
    this.baseDirectory = path.join(process.cwd(), 'dist', 'public');
    this.ensureDirectories();
  }

  async onModuleInit() {
    await this.cleanupExpiredFiles().catch((error) => {
      console.error('启动清理文件失败: 🔴🔴🔴', error);
    });
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredFiles().catch((error) => {
        console.error('定时清理文件失败: 🔴🔴🔴', error);
      });
    }, this.CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  onModuleDestroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private ensureDirectories(): void {
    try {
      // 首先确保基础目录存在
      if (!fs.existsSync(this.baseDirectory)) {
        console.log(`创建基础目录: ${this.baseDirectory}`);
        fs.mkdirSync(this.baseDirectory, { recursive: true });
      }

      // 然后创建子目录
      this.PUBLIC_SUB_DIRS.forEach((dir) => {
        const fullPath = path.join(this.baseDirectory, dir);
        if (!fs.existsSync(fullPath)) {
          console.log(`创建子目录: ${fullPath}`);
          fs.mkdirSync(fullPath, { recursive: true });
        }
      });
    } catch (error) {
      console.error('创建目录时发生错误:', error);
      throw new HttpException(
        `创建目录失败: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private getExtensionFromContentType(
    contentType: string,
    type: 'video' | 'image',
  ): string | null {
    if (!contentType) {
      return null;
    }

    // 视频格式映射
    const videoTypeMap: Record<string, string> = {
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'video/quicktime': '.mov',
      'video/x-msvideo': '.avi',
      'video/x-matroska': '.mkv',
    };

    // 图片格式映射
    const imageTypeMap: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
    };

    const typeMap = type === 'video' ? videoTypeMap : imageTypeMap;
    const normalizedContentType = contentType
      .toLowerCase()
      .split(';')[0]
      .trim();

    return typeMap[normalizedContentType] || null;
  }

  private getRequestHeaders(
    url: URL,
    type: 'video' | 'image',
  ): Record<string, string> {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      Accept:
        type === 'image'
          ? 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
          : 'video/*,*/*;q=0.8',
      Connection: 'keep-alive',
      'Cache-Control': 'no-cache',
      Referer: `${url.protocol}//${url.host}/`,
    };
  }

  private getMaxFileSizeBytes(type: 'video' | 'image'): number {
    const maxSizeMb =
      type === 'video' ? this.MAX_VIDEO_SIZE_MB : this.MAX_IMAGE_SIZE_MB;
    return maxSizeMb * 1024 * 1024;
  }

  private getDownloadTimeoutMs(type: 'video' | 'image'): number {
    return type === 'video'
      ? this.VIDEO_DOWNLOAD_TIMEOUT_MS
      : this.IMAGE_DOWNLOAD_TIMEOUT_MS;
  }

  private parseDownloadUrl(fileUrl: string): URL {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(fileUrl);
    } catch (error) {
      throw new HttpException('请提供有效的URL', HttpStatus.BAD_REQUEST);
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new HttpException(
        '仅支持 http 或 https 地址',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (parsedUrl.username || parsedUrl.password) {
      throw new HttpException('不支持带账号密码的地址', HttpStatus.BAD_REQUEST);
    }

    return parsedUrl;
  }

  private normalizeHostname(hostname: string): string {
    return hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  }

  private isBlockedHostname(hostname: string): boolean {
    return ['localhost', 'localhost.localdomain'].includes(
      hostname.toLowerCase(),
    );
  }

  private getMappedIpv4(address: string): string | null {
    const normalized = address.toLowerCase();
    if (!normalized.startsWith('::ffff:')) {
      return null;
    }

    const suffix = normalized.slice('::ffff:'.length);
    if (net.isIP(suffix) === 4) {
      return suffix;
    }

    const hexParts = suffix.split(':');
    if (
      hexParts.length !== 2 ||
      hexParts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
    ) {
      return null;
    }

    const high = parseInt(hexParts[0], 16);
    const low = parseInt(hexParts[1], 16);
    return [
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 8) & 0xff,
      low & 0xff,
    ].join('.');
  }

  private isBlockedIp(address: string): boolean {
    const normalizedAddress = this.normalizeHostname(address).toLowerCase();
    const mappedIpv4 = this.getMappedIpv4(normalizedAddress);
    if (mappedIpv4) {
      return this.isBlockedIp(mappedIpv4);
    }

    const ipVersion = net.isIP(normalizedAddress);
    if (!ipVersion) {
      return false;
    }

    if (ipVersion === 4) {
      const parts = normalizedAddress.split('.').map((part) => Number(part));
      const [first, second] = parts;
      return (
        first === 0 ||
        first === 10 ||
        first === 127 ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        first >= 224
      );
    }

    const normalized = normalizedAddress;
    const firstSegment = parseInt(normalized.split(':')[0] || '0', 16);
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized === '0:0:0:0:0:0:0:0' ||
      normalized === '0:0:0:0:0:0:0:1' ||
      (firstSegment >= 0xfc00 && firstSegment <= 0xfdff) ||
      (firstSegment >= 0xfe80 && firstSegment <= 0xfebf) ||
      (firstSegment >= 0xff00 && firstSegment <= 0xffff)
    );
  }

  private async assertPublicRemoteUrl(url: URL): Promise<void> {
    const hostname = this.normalizeHostname(url.hostname);
    if (this.isBlockedHostname(hostname)) {
      throw new HttpException('不支持下载内网地址', HttpStatus.BAD_REQUEST);
    }

    if (this.isBlockedIp(hostname)) {
      throw new HttpException('不支持下载内网地址', HttpStatus.BAD_REQUEST);
    }

    let addresses: dns.LookupAddress[];
    try {
      addresses = await dns.promises.lookup(hostname, {
        all: true,
        verbatim: false,
      });
    } catch (error) {
      throw new HttpException('域名解析失败', HttpStatus.BAD_REQUEST);
    }
    const blockedAddress = addresses.find((item) =>
      this.isBlockedIp(item.address),
    );
    if (blockedAddress) {
      throw new HttpException('不支持下载内网地址', HttpStatus.BAD_REQUEST);
    }
  }

  private safeLookup(
    hostname: string,
    options: dns.LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | dns.LookupAddress[],
      family?: number,
    ) => void,
  ) {
    dns.lookup(
      this.normalizeHostname(hostname),
      options,
      (error, address, family) => {
        if (error) {
          callback(error, address as string, family);
          return;
        }

        const addresses = Array.isArray(address)
          ? address.map((item) => item.address)
          : [address];
        const blockedAddress = addresses.find((item) => this.isBlockedIp(item));
        if (blockedAddress) {
          const blockedError = new Error(
            '不支持下载内网地址',
          ) as NodeJS.ErrnoException;
          blockedError.code = 'ERR_PRIVATE_ADDRESS';
          callback(blockedError, address as string, family);
          return;
        }

        callback(null, address, family);
      },
    );
  }

  private getAxiosRequestConfig(
    url: URL,
    type: 'video' | 'image',
    timeout: number,
  ): AxiosRequestConfig {
    return {
      headers: this.getRequestHeaders(url, type),
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      maxRedirects: 3,
      timeout,
      decompress: false,
    };
  }

  private sanitizeNamePrefix(namePrefix: string): string {
    const normalized = String(namePrefix || '')
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 64);
    return normalized || 'file';
  }

  private resolveFileExtension(
    fileUrl: string,
    type: 'video' | 'image',
  ): string {
    const supportedFormats =
      type === 'video'
        ? this.SUPPORTED_VIDEO_FORMATS
        : this.SUPPORTED_IMAGE_FORMATS;
    const defaultExtension = type === 'video' ? '.mp4' : '.jpg';

    try {
      const url = new URL(fileUrl);
      const pathname = url.pathname;
      const ext = path.extname(pathname).toLowerCase();

      if (!ext) {
        // 对于无后缀的文件，使用默认后缀并允许下载
        return defaultExtension;
      }

      if (!supportedFormats.includes(ext)) {
        throw new HttpException(
          `不支持的${type === 'video' ? '视频' : '图片'}格式。支持的格式：${supportedFormats.join(', ')}`,
          HttpStatus.BAD_REQUEST,
        );
      }

      return ext;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      // 如果 URL 解析失败，回退到默认后缀
      return defaultExtension;
    }
  }

  private async validateFileSize(
    url: URL,
    type: 'video' | 'image',
  ): Promise<{ size: number; extension: string | null; contentType: string }> {
    try {
      let contentLength: string;
      let contentType: string;

      // 首先尝试 HEAD 请求
      try {
        const headResponse = await axios.head(
          url.toString(),
          this.getAxiosRequestConfig(url, type, this.VALIDATE_TIMEOUT_MS),
        );
        contentLength = headResponse.headers['content-length'];
        contentType = headResponse.headers['content-type'];

        if (contentLength && contentType) {
          const size = this.validateContentTypeAndSize(
            contentLength,
            contentType,
            type,
          );
          const extension = this.getExtensionFromContentType(contentType, type);
          return { size, extension, contentType };
        }
      } catch (error) {
        console.log('HEAD 请求失败，尝试 GET 请求');
      }

      // 如果 HEAD 请求失败，尝试 GET 请求并只获取头部信息
      const response = await axios.get(url.toString(), {
        ...this.getAxiosRequestConfig(url, type, this.VALIDATE_TIMEOUT_MS),
        responseType: 'stream',
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      try {
        contentLength = response.headers['content-length'];
        contentType = response.headers['content-type'];

        const size = this.validateContentTypeAndSize(
          contentLength,
          contentType,
          type,
        );
        const extension = this.getExtensionFromContentType(contentType, type);
        return { size, extension, contentType };
      } finally {
        response.data.destroy();
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `文件验证失败: ${error.message}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  // 抽取验证逻辑到单独的方法
  private validateContentTypeAndSize(
    contentLength: string,
    contentType: string,
    type: 'video' | 'image',
  ): number {
    const normalizedContentType = String(contentType || '').toLowerCase();

    // 内容类型验证可以放宽松一点，因为有些服务器可能返回通用的 content-type
    if (
      normalizedContentType &&
      type === 'video' &&
      !normalizedContentType.includes('video') &&
      !normalizedContentType.includes('application/octet-stream')
    ) {
      throw new HttpException(`不是有效的视频文件`, HttpStatus.BAD_REQUEST);
    }

    if (
      normalizedContentType &&
      type === 'image' &&
      !normalizedContentType.includes('image') &&
      !normalizedContentType.includes('application/octet-stream')
    ) {
      throw new HttpException(`不是有效的图片文件`, HttpStatus.BAD_REQUEST);
    }

    const maxSize =
      type === 'video' ? this.MAX_VIDEO_SIZE_MB : this.MAX_IMAGE_SIZE_MB;
    const contentLengthBytes = Number(contentLength);
    if (!Number.isFinite(contentLengthBytes) || contentLengthBytes <= 0) {
      return 0;
    }
    const fileSizeInMegabytes = contentLengthBytes / (1024 * 1024);

    if (fileSizeInMegabytes > maxSize) {
      throw new HttpException(
        `文件大小(${fileSizeInMegabytes.toFixed(2)}MB)超过限制 ${maxSize}MB`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    return fileSizeInMegabytes;
  }

  private detectFileExtensionFromSignature(
    buffer: Buffer,
    type: 'video' | 'image',
  ): string | null {
    const isJpeg =
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff;
    const isPng =
      buffer.length >= 8 &&
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isGif = buffer.subarray(0, 6).toString('ascii').startsWith('GIF');
    const isWebp =
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    const isMp4Like =
      buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
    const isAvi =
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'AVI ';
    const isWebmOrMkv =
      buffer.length >= 4 &&
      buffer[0] === 0x1a &&
      buffer[1] === 0x45 &&
      buffer[2] === 0xdf &&
      buffer[3] === 0xa3;

    const imageSignatureMap: Record<string, boolean> = {
      '.jpg': isJpeg,
      '.jpeg': isJpeg,
      '.png': isPng,
      '.gif': isGif,
      '.webp': isWebp,
    };
    const videoSignatureMap: Record<string, boolean> = {
      '.mp4': isMp4Like,
      '.mov': isMp4Like,
      '.avi': isAvi,
      '.webm': isWebmOrMkv,
      '.mkv': isWebmOrMkv,
    };
    const signatureMap =
      type === 'image' ? imageSignatureMap : videoSignatureMap;

    return (
      Object.entries(signatureMap).find(([, isMatched]) => isMatched)?.[0] ||
      null
    );
  }

  private validateFileSignature(
    buffer: Buffer,
    type: 'video' | 'image',
  ): string {
    const detectedExtension = this.detectFileExtensionFromSignature(
      buffer,
      type,
    );
    if (!detectedExtension) {
      throw new HttpException(
        `文件内容不是有效的${type === 'video' ? '视频' : '图片'}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    return detectedExtension;
  }

  private async validateSavedFile(
    filePath: string,
    type: 'video' | 'image',
  ): Promise<string> {
    const fileHandle = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(32);
      const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0);
      return this.validateFileSignature(buffer.subarray(0, bytesRead), type);
    } finally {
      await fileHandle.close();
    }
  }

  private async downloadAndSaveFile(
    url: URL,
    filePath: string,
    type: 'video' | 'image',
  ): Promise<{ size: number; detectedExtension: string }> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, this.getDownloadTimeoutMs(type));

    try {
      const response = await axios({
        url: url.toString(),
        method: 'GET',
        ...this.getAxiosRequestConfig(
          url,
          type,
          this.getDownloadTimeoutMs(type),
        ),
        responseType: 'stream',
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        signal: abortController.signal,
      });

      let downloadedBytes = 0;
      const maxBytes = this.getMaxFileSizeBytes(type);
      const sizeLimiter = new Transform({
        transform(chunk, encoding, callback) {
          downloadedBytes += chunk.length;
          if (downloadedBytes > maxBytes) {
            callback(
              new HttpException(
                `文件大小超过限制 ${type === 'video' ? '100MB' : '10MB'}`,
                HttpStatus.PAYLOAD_TOO_LARGE,
              ),
            );
            return;
          }
          callback(null, chunk);
        },
      });

      await pipeline(
        response.data,
        sizeLimiter,
        fs.createWriteStream(filePath),
      );

      const detectedExtension = await this.validateSavedFile(filePath, type);
      const stats = fs.statSync(filePath);
      return {
        size: stats.size / (1024 * 1024),
        detectedExtension,
      };
    } catch (error) {
      await fs.promises.unlink(filePath).catch(() => undefined);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `文件下载失败: ${error.message}`,
        HttpStatus.BAD_REQUEST,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async downloadFile(
    fileUrl: string,
    namePrefix: string,
    type: 'video' | 'image',
  ): Promise<{ url: string; size: number }> {
    try {
      const parsedUrl = this.parseDownloadUrl(fileUrl);
      await this.assertPublicRemoteUrl(parsedUrl);
      console.log('开始下载文件: 🔵🔵🔵', parsedUrl.toString());

      // 验证文件大小并获取Content-Type信息
      const validationResult = await this.validateFileSize(
        parsedUrl,
        type,
      ).catch((error) => {
        console.error('文件大小验证失败: 🔴🔴🔴', error);
        throw error;
      });

      console.log('文件大小: 🔵🔵🔵', validationResult.size, 'MB');
      console.log('Content-Type: 🔵🔵🔵', validationResult.contentType);

      // 优先使用Content-Type确定的扩展名，否则回退到URL解析
      let fileExtension = validationResult.extension;
      if (!fileExtension) {
        console.log('无法从Content-Type确定扩展名，尝试从URL解析');
        fileExtension = this.resolveFileExtension(parsedUrl.toString(), type);
      }
      console.log('使用文件扩展名: 🔵🔵🔵', fileExtension);

      const fileName = `${this.sanitizeNamePrefix(namePrefix)}_${Date.now()}${fileExtension}`;
      const subDir = type === 'video' ? 'videos' : 'images';
      const filePath = path.join(this.baseDirectory, subDir, fileName);

      const downloadResult = await this.downloadAndSaveFile(
        parsedUrl,
        filePath,
        type,
      );
      const finalFile =
        downloadResult.detectedExtension === fileExtension
          ? { name: fileName, path: filePath }
          : await this.renameFileWithDetectedExtension(
              filePath,
              fileName,
              downloadResult.detectedExtension,
            );
      this.scheduleFileDeletion(finalFile.path);
      const fileSizeInMB = downloadResult.size;
      console.log('文件下载完成，大小: 🟢🟢🟢', fileSizeInMB, 'MB');

      return {
        url: `${this.downloadPath}/${subDir}/${finalFile.name}`,
        size: +fileSizeInMB.toFixed(2),
      };
    } catch (error) {
      console.error('下载文件时发生错误: 🔴🔴🔴', error);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `下载失败: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private scheduleFileDeletion(filePath: string): void {
    const deleteAfterMs = this.DELETE_AFTER_HOURS * 60 * 60 * 1000;
    const deleteTimer = setTimeout(() => {
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error('删除文件失败: 🔴🔴🔴', err);
          return;
        }
        console.log('文件已成功删除: 🟢🟢🟢');
      });
    }, deleteAfterMs);
    deleteTimer.unref();
  }

  private async renameFileWithDetectedExtension(
    filePath: string,
    fileName: string,
    detectedExtension: string,
  ): Promise<{ path: string; name: string }> {
    const parsedPath = path.parse(filePath);
    const finalFileName = `${path.parse(fileName).name}${detectedExtension}`;
    const finalFilePath = path.join(parsedPath.dir, finalFileName);
    await fs.promises.rename(filePath, finalFilePath);
    return {
      name: finalFileName,
      path: finalFilePath,
    };
  }

  private async cleanupExpiredFiles(): Promise<void> {
    const expireBefore = Date.now() - this.DELETE_AFTER_HOURS * 60 * 60 * 1000;
    await Promise.all(
      this.PUBLIC_SUB_DIRS.map(async (dir) => {
        const fullPath = path.join(this.baseDirectory, dir);
        const files = await fs.promises
          .readdir(fullPath, {
            withFileTypes: true,
          })
          .catch((error) => {
            console.error('读取转存目录失败: 🔴🔴🔴', error);
            return [];
          });
        await Promise.all(
          files
            .filter((file) => file.isFile())
            .map(async (file) => {
              const filePath = path.join(fullPath, file.name);
              const stat = await fs.promises.stat(filePath).catch(() => null);
              if (!stat || stat.mtimeMs > expireBefore) {
                return;
              }
              await fs.promises.unlink(filePath).catch((error) => {
                console.error('清理过期文件失败: 🔴🔴🔴', error);
              });
            }),
        );
      }),
    );
  }
}

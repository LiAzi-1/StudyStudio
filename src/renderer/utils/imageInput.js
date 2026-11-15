/**
 * 图片输入工具：把用户选的文件 / 粘贴的剪贴板图片转成可发给模型的 base64。
 *
 * Windows 上拖拽进来的图片 File.type 可能是空的；部分视觉服务也不接受 gif / bmp。
 * 这里按扩展名兜底判定 MIME，并把不受支持的格式统一转成 PNG，
 * 保证 data URL 的 MIME 和实际内容一致，不会出现「声明是 png 实际是 gif」。
 */

const IMAGE_MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

export const MAX_ASSISTANT_IMAGES = 4;

/** 单张图片体积上限：太大既慢又容易超出多数服务商的请求上限 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function convertImageToPng(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      canvas.getContext('2d').drawImage(image, 0, 0);
      resolve(canvas.toDataURL('image/png').split(',')[1]);
    };
    image.onerror = () => reject(new Error('图片解码失败，请改用 PNG / JPG 格式'));
    image.src = dataUrl;
  });
}

export async function readFileAsBase64(file) {
  if (!file) throw new Error('没有读到图片文件');
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片太大（${(file.size / 1024 / 1024).toFixed(1)}MB），请压缩后再发`);
  }

  const ext = String(file.name || '').split('.').pop().toLowerCase();
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });

  const mimeType = IMAGE_MIME_BY_EXT[ext] || file.type || 'image/png';
  if (mimeType === 'image/gif' || mimeType === 'image/bmp' || !mimeType.startsWith('image/')) {
    return { base64: await convertImageToPng(dataUrl), mimeType: 'image/png' };
  }
  return { base64: dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl, mimeType };
}

/** 从剪贴板事件里取出图片文件（纯文本粘贴不在这里处理） */
export function extractClipboardImages(event) {
  const items = event?.clipboardData?.items;
  if (!items) return [];
  const files = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind === 'file' && String(item.type || '').startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

/** 从拖拽事件里取出图片文件 */
export function extractDroppedImages(event) {
  const files = event?.dataTransfer?.files;
  if (!files) return [];
  return Array.from(files).filter((file) => String(file.type || '').startsWith('image/'));
}

import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const workspace = process.cwd();
const source = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(workspace, 'resources', 'icon-source.png');
const resources = path.join(workspace, 'resources');

await mkdir(resources, { recursive: true });

const icon = await sharp(source)
  .resize(1024, 1024, { fit: 'cover' })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toBuffer();

await sharp(icon).toFile(path.join(resources, 'icon.png'));
await sharp({
  create: { width: 2732, height: 2732, channels: 4, background: '#07152f' }
})
  .composite([{ input: icon, gravity: 'center' }])
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(path.join(resources, 'splash.png'));
await copyFile(path.join(resources, 'splash.png'), path.join(resources, 'splash-dark.png'));

console.log('Generated valid 1024px icon and 2732px splash masters.');

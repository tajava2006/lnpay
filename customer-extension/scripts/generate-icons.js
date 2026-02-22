import sharp from 'sharp';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';

const sizes = [16, 48, 128];
const outputDir = 'src/assets';

async function generateIcons() {
  await mkdir(outputDir, { recursive: true });

  for (const size of sizes) {
    const svg = `
      <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${size}" height="${size}" rx="${size * 0.15}" fill="#4F46E5"/>
        <text x="50%" y="55%" font-family="Arial, sans-serif" font-size="${size * 0.5}"
              fill="white" text-anchor="middle" dominant-baseline="middle" font-weight="bold">W</text>
      </svg>
    `;

    await sharp(Buffer.from(svg))
      .png()
      .toFile(`${outputDir}/icon-${size}.png`);

    console.log(`Generated icon-${size}.png`);
  }

  console.log('All icons generated successfully!');
}

generateIcons().catch(console.error);

import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DateTime } from "luxon";
import { TJ_FOLDERS, TJ_URL } from "@/constant/transjakarta";
import * as cheerio from "cheerio";

export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const currentDate = DateTime.now().setZone('Asia/Jakarta').toFormat('yyyyMMdd');

  const s3Client = new S3Client({
    credentials: {
      accessKeyId: process.env.AWS_KEY,
      secretAccessKey: process.env.AWS_SECRET
    },
    region: 'us-east-1',
    endpoint: process.env.AWS_URL,
    forcePathStyle: true
  });

  // Fetch page
  let rawHTML = "";
  try {
    const page = await s3Client.send(new GetObjectCommand({
      Bucket: process.env.AWS_BUCKET!,
      Key: `${TJ_FOLDERS.PAGES}/${currentDate}.html`
    }));
    if (page.$metadata.httpStatusCode === 200 && page.Body) {
      rawHTML = await page.Body.transformToString();
    }
  }
  catch (error) {
    if (error instanceof NoSuchKey) {
      const tj = await fetch(TJ_URL);
      if (!tj.ok) {
        return new Response('Failed to fetch Transjakarta page', { status: tj.status });
      }
      rawHTML = await tj.text();
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET!,
        Key: `${TJ_FOLDERS.PAGES}/${currentDate}.html`,
        Body: rawHTML,
        ContentType: 'text/html'
      }));
    }
    else throw error;
  }

  // Grab JSON
  const data = await s3Client.send(new GetObjectCommand({
    Bucket: process.env.AWS_BUCKET!,
    Key: `${TJ_FOLDERS.JSON}/master.json`
  }));
  const parsedData = await data.Body?.transformToString();
  if (!parsedData) {
    return new Response('Failed to fetch data from S3. No data', { status: 500 });
  }

  const oldCorridorRaw = JSON.parse(parsedData) as Route[];
  const oldCorridor = oldCorridorRaw
    .reduce((acc, curr) => {
      const existing = acc.find(x => x.code === curr.code);
      if (!existing || new Date(curr.effectiveDate).getTime() > new Date(existing.effectiveDate).getTime()) {
        return [...acc.filter(x => x.code !== curr.code), curr];
      }
      return acc;
    }, [] as Route[]);

  // Parse HTML using cheerio
  const $ = cheerio.load(rawHTML);

  const categories = $('.accordion .accordion-item').slice(1); // Skip first item
  
  if (categories.length === 0) {
    return new Response('No categories found. Maybe the webpage structure has been changed? Structure: .accordion .accordion-item', { status: 500 });
  }

  console.log(`Found ${categories.length} categories`);

  const availableCorridor: string[] = [];
  const newCorridor: CorridorData[] = [];

  // Parse each category
  const toDownload: { code: string; imagePath: string; imageLink: string }[] = [];
  categories.each((_, categoryEl) => {
    const $category = $(categoryEl);
    const headerButton = $category.find('h2 button');
    
    if (headerButton.length === 0) {
      throw new Error('Category name element not found. Maybe the webpage structure has been changed? Structure: .accordion .accordion-item > h2 button');
    }

    const categoryName = normalize(headerButton.text());
    console.log(`Processing category: ${categoryName}`);

    const corridorElements = $category.find('#rute');
    
    if (corridorElements.length === 0) {
      throw new Error(`No routes found for category ${categoryName}. Maybe the webpage structure has been changed? Structure: .accordion .accordion-item > #rute`);
    }

    corridorElements.each((_, corridorEl) => {
      const $corridor = $(corridorEl);
      
      const nomorEl = $corridor.find('.nomor');
      const namaEl = $corridor.find('.nama a');

      if (nomorEl.length === 0) {
        throw new Error('Corridor number element not found. Maybe the webpage structure has been changed? Structure: .nomor');
      }

      if (namaEl.length === 0) {
        throw new Error('Corridor name element not found. Maybe the webpage structure has been changed? Structure: .nama a');
      }

      const imageLink = namaEl.attr('href');
      if (!imageLink) {
        throw new Error('Image link not found. Maybe the webpage structure has been changed? Structure: .nama a href');
      }

      const color = translateColor(nomorEl.css('background-color') || nomorEl.css('background') || '');
      const code = normalize(nomorEl.html() || '').toUpperCase();
      const name = normalize(namaEl.html() || '');

      availableCorridor.push(code);

      const imageExtension = imageLink.includes('.')
        ? '.' + imageLink.split('.').pop()?.split('?')[0]
        : '.jpg';
      
      const imageName = `${code}-${currentDate}${imageExtension}`;
      const imagePath = `${TJ_FOLDERS.ROUTES}/${code}/${imageName}`;

      const prevVersion = oldCorridor.find(x => x.code === code)

      const isImageNew = !prevVersion || prevVersion.imageLink !== imageLink;
      const isNonImageNew = !prevVersion || 
        prevVersion.category !== categoryName || 
        prevVersion.name !== name || 
        prevVersion.color !== color || 
        prevVersion.isDeleted;

      if (isImageNew || isNonImageNew) {
        if (isImageNew) {
          toDownload.push({ code, imagePath, imageLink });
        }
        newCorridor.push({
          code,
          category: categoryName,
          name,
          color,
          imageLink,
          imagePath,
          isImageNew,
          prevPictureVersion: prevVersion?.pictureEffectiveDate || null
        });

        console.log(`Corridor ${code} is new or updated. Image updated: ${isImageNew}, Non-image data updated: ${isNonImageNew}`);
      }
    });
  });

  console.log(`Found ${availableCorridor.length} corridors. New or updated: ${newCorridor.length}`);

  // Download images for new/updated corridors
  for (const corridor of toDownload) {
    await downloadImage(s3Client, corridor.imagePath, corridor.imageLink);
  }

  // Check for deleted corridors
  const deletedCorridor = oldCorridor
    .filter(x => !availableCorridor.includes(x.code) && !x.isDeleted)
    .map(x => ({
      ...x,
      isDeleted: true,
      effectiveDate: currentDate
    }));

  console.log(`Found ${deletedCorridor.length} deleted corridors`);

  // Create final corridor data
  const finalCorridorData: Route[] = structuredClone(oldCorridorRaw);

  // Add new/updated corridors
  for (const corridor of newCorridor) {
    finalCorridorData.push({
      ...corridor,
      no: finalCorridorData.length + 1,
      pictureEffectiveDate: corridor.isImageNew ? currentDate : corridor.prevPictureVersion || currentDate,
      effectiveDate: currentDate,
      isDeleted: false
    });
  }

  // Add deleted corridors
  for (const corridor of deletedCorridor) {
    finalCorridorData.push({
      ...corridor,
      no: finalCorridorData.length + 1,
      effectiveDate: currentDate,
      isDeleted: true
    });
  }

  console.log(`Final corridor data contains ${finalCorridorData.length} entries (${newCorridor.length} new/updated, ${deletedCorridor.length} deleted)`);

  // Save to S3 as JSON
  if (finalCorridorData.length !== oldCorridorRaw.length) {
    try {
      const jsonContent = JSON.stringify(finalCorridorData, null, 2);
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET!,
        Key: `${TJ_FOLDERS.JSON}/master.json`,
        Body: jsonContent,
        ContentType: 'application/json'
      }));
      console.log('Successfully saved corridor data to S3 as JSON');
    } catch (error) {
      console.error('Error saving corridor data to S3:', error);
      return new Response('Failed to save corridor data', { status: 500 });
    }
  }

  return Response.json({ 
    success: true, 
    availableCorridors: availableCorridor.length,
    newOrUpdated: newCorridor.length,
    deleted: deletedCorridor.length,
    totalSaved: finalCorridorData.length,
    message: 'Corridor data fetched and saved successfully'
  }, { status: 200 });
}

// Helper function to normalize text (trim whitespace)
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

// Helper function to translate color from CSS to readable format
function translateColor(cssColor: string): string {
  // Check if the color is in hex format
  if (/^#([0-9A-F]{3}){1,2}$/i.test(cssColor)) {
    return cssColor.toUpperCase();
  }

  // Convert 'rgb(r, g, b)' to hex
  const rgbMatch = cssColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!rgbMatch) {
    throw new Error(`Invalid CSS color format: ${cssColor}`);
  }
  const r = parseInt(rgbMatch[1], 10);
  const g = parseInt(rgbMatch[2], 10);
  const b = parseInt(rgbMatch[3], 10);
  return ("#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1)).toUpperCase();
}

// Separate function for downloading images
async function downloadImage(s3Client: S3Client, imagePath: string, imageLink: string): Promise<void> {
  try {
    const imageResponse = await fetch(imageLink, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image from ${imageLink}. Status: ${imageResponse.status}`);
    }

    const imageBuffer = await imageResponse.arrayBuffer();

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET!,
      Key: imagePath,
      Body: new Uint8Array(imageBuffer),
      ContentType: imageResponse.headers.get('content-type') || 'image/jpeg'
    }));

    console.log(`Successfully downloaded and uploaded image to ${imagePath}`);
  } catch (error) {
    console.error(`Error downloading image from ${imageLink}:`, error);
    throw error;
  }
}

interface Route {
  no: number;
  code: string;
  category: string;
  color: string;
  name: string;
  imageLink: string;
  pictureEffectiveDate: string;
  effectiveDate: string;
  isDeleted: boolean;
}

interface CorridorData {
  code: string;
  category: string;
  name: string;
  color: string;
  imageLink: string;
  imagePath: string;
  isImageNew: boolean;
  prevPictureVersion: string | null;
}
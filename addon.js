const express = require('express');
const { addonBuilder } = require('stremio-addon-sdk');
const puppeteer = require('puppeteer');
const { MongoClient, ServerApiVersion } = require('mongodb');
const cron = require('node-cron');

// MongoDB Connection
const uri = "mongodb+srv://brucewill945:7ZXQEoqgK0SUIaUG@cluster0.94wexnp.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

// Create a MongoClient with a MongoClientOptions object
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Initialize Database Connection
let db;
async function initializeDB() {
  try {
    await client.connect();
    db = client.db("stremio_scraper");
    console.log("Connected to MongoDB successfully!");
  } catch (err) {
    console.error("Error connecting to MongoDB:", err.message);
    process.exit(1); // Exit if the database connection fails
  }
}

// Define Schema and Model Replacement
// Since we are using MongoClient directly, we will use plain MongoDB queries instead of Mongoose models.
const collectionName = "scraped_entries";

// Express Server
const app = express();
app.use(express.json());

// Dynamic Site List in Memory
let sitesToScrape = [];

// Rotating User-Agent List
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64)...',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)...',
  'Mozilla/5.0 (X11; Linux x86_64)...',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)...',
];

// Puppeteer Fetch Function
async function fetchPageData(url, browser) {
  const page = await browser.newPage();
  await page.setUserAgent(userAgents[Math.floor(Math.random() * userAgents.length)]);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const data = await page.evaluate(() => {
      const getContent = (selector) => document.querySelector(selector)?.content || 'No Data';

      const videos = Array.from(document.querySelectorAll('a[href], iframe[src]'))
        .map(el => el.href || el.src)
        .filter(link => /\.(mp4|m3u8|avi|mov)$/i.test(link) || /vidstream|dood|streamsb|streamtape/.test(link));

      const subLinks = Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(href => href.startsWith(location.origin));

      return {
        title: document.title || 'No Title',
        description: getContent('meta[name="description"]'),
        image: getContent('meta[property="og:image"]'),
        videos,
        subLinks,
      };
    });

    await page.close();
    return data;

  } catch (err) {
    console.error(`Error scraping ${url}:`, err.message);
    await page.close();
    return null;
  }
}

// Scraping Logic
async function scrapeSite(site, browser, visited = new Set()) {
  const { url, id: catalogId } = site;

  if (visited.has(url)) return;
  visited.add(url);

  console.log(`Scraping: ${url}`);

  const data = await fetchPageData(url, browser);
  if (!data) return;

  const { videos, subLinks, title, description, image } = data;

  for (const videoUrl of videos) {
    const entryId = Buffer.from(videoUrl).toString('base64');
    await db.collection(collectionName).updateOne(
      { id: entryId, catalogId },
      { $set: { catalogId, id: entryId, name: title, description, poster: image, videoUrl } },
      { upsert: true }
    );
  }

  for (const subLink of subLinks) {
    await scrapeSite({ url: subLink, id: catalogId }, browser, visited);
  }
}

// Refresh Scraping
async function refreshScraping() {
  console.log('Starting scraping process...');
  const browser = await puppeteer.launch({ headless: true });

  for (const site of sitesToScrape) {
    await scrapeSite(site, browser);
  }

  await browser.close();
  console.log('Scraping process completed at', new Date().toLocaleString());
}

// Schedule Regular Scraping
cron.schedule('0 */2 * * *', refreshScraping); // Every 2 hours
refreshScraping(); // Run immediately on server start

// Stremio Addon Builder
const builder = new addonBuilder({
  id: 'org.auto.multi-scraper',
  version: '1.0.0',
  name: 'Multi-Site Scraper',
  description: 'Auto-updating multi-site scraper for Stremio.',
  catalogs: () => {
    return sitesToScrape.map(site => ({
      type: 'movie',
      id: site.id,
      name: `Movies from ${new URL(site.url).hostname}`,
    }));
  },
  resources: ['catalog', 'stream', 'meta'],
  types: ['movie'],
});

// Stremio Handlers
builder.defineCatalogHandler(async ({ id, extra }) => {
  const query = extra.search?.toLowerCase() || '';
  const entries = await db.collection(collectionName).find({ catalogId: id }).toArray();

  const filteredEntries = query
    ? entries.filter(entry => entry.name.toLowerCase().includes(query))
    : entries;

  const metas = filteredEntries.map(entry => ({
    id: entry.id,
    type: 'movie',
    name: entry.name,
    poster: entry.poster,
    description: entry.description,
  }));

  return Promise.resolve({ metas });
});

builder.defineStreamHandler(async ({ id }) => {
  const entry = await db.collection(collectionName).findOne({ id });
  if (entry) {
    return Promise.resolve({ streams: [{ url: entry.videoUrl }] });
  }
  return Promise.resolve({ streams: [] });
});

builder.defineMetaHandler(async ({ id }) => {
  const entry = await db.collection(collectionName).findOne({ id });
  if (entry) {
    return Promise.resolve({
      meta: {
        id: entry.id,
        type: 'movie',
        name: entry.name,
        poster: entry.poster,
        description: entry.description,
      },
    });
  }
  return Promise.resolve({});
});

module.exports = builder.getInterface();

// API to Add Sites Dynamically
app.post('/add-site', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).send({ error: 'Missing URL' });

  const domain = new URL(url).hostname.replace(/\./g, '-');
  const catalogId = `catalog-${domain}`;

  sitesToScrape.push({ url, id: catalogId });

  console.log(`Added new site: ${url} (Catalog ID: ${catalogId})`);

  await refreshScraping(); // Trigger immediate scrape

  res.send({ success: true, catalogId });
});

// Start Express Server
const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
  await initializeDB(); // Initialize MongoDB connection
  console.log(`Scraper addon server running on port ${PORT}`);
});

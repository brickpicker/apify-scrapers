import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import { router } from './routes.js';

interface Input {
    startUrl: string;
    maxProducts: number;
    proxyConfiguration?: {
        useApifyProxy?: boolean;
        apifyProxyGroups?: string[];
    };
}

await Actor.init();

const input = await Actor.getInput<Input>() ?? {
    startUrl: 'https://www.lego.com/en-us/categories/all-sets?filters.i0.key=categories.id&filters.i0.values.i0=12ba8640-7fb5-4281-991d-ac55c65d8001',
    maxProducts: 0,
};

const proxyConfiguration = input.proxyConfiguration
    ? await Actor.createProxyConfiguration(input.proxyConfiguration)
    : undefined;

// Store config in a way routes can access
Actor.on('migrating', async () => {
    log.info('Actor is migrating, saving state...');
});

const crawler = new PlaywrightCrawler({
    proxyConfiguration,

    // Performance settings
    maxConcurrency: 10,              // Run up to 10 browsers in parallel
    minConcurrency: 3,               // Always keep at least 3 running
    maxRequestsPerMinute: 120,       // Rate limit to avoid blocks

    // Timeout settings
    maxRequestRetries: 2,            // Fewer retries = faster failures
    requestHandlerTimeoutSecs: 600,  // 10 minutes for catalog page to load all products
    navigationTimeoutSecs: 60,       // 1 minute for page navigation

    // Use a more realistic browser setup to avoid detection
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--no-sandbox',
                '--disable-gpu',
            ],
        },
    },

    // Pre-navigation hooks for stealth
    preNavigationHooks: [
        async ({ page }) => {
            // Set a realistic viewport
            await page.setViewportSize({ width: 1920, height: 1080 });

            // Add extra headers
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
            });
        },
    ],

    requestHandler: router,
});

// Add the start URL
const startUrl = input.startUrl || 'https://www.lego.com/en-us/categories/all-sets';

log.info(`Starting LEGO scraper with URL: ${startUrl}`);
log.info(`Max products: ${input.maxProducts || 'unlimited'}`);

await crawler.run([{
    url: startUrl,
    label: 'CATALOG',
    userData: {
        maxProducts: input.maxProducts,
    },
}]);

await Actor.exit();

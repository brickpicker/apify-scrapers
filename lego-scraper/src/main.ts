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
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 60,

    // Use a more realistic browser setup to avoid detection
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
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

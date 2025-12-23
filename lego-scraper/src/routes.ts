import { Actor } from 'apify';
import { createPlaywrightRouter, Dataset, log } from 'crawlee';
import type { Page, Response } from 'playwright';

export const router = createPlaywrightRouter();

interface LegoProduct {
    setNumber: string;
    name: string;
    theme: string;
    pieces: number | null;
    minifigures: number | null;
    rating: number | null;
    reviewCount: number | null;
    price: string | null;
    originalPrice: string | null;
    availability: string;
    tags: string[];
    imageUrl: string;
    productUrl: string;
    scrapedAt: string;
}

interface ApiProduct {
    id?: string;
    productCode?: string;
    name?: string;
    slug?: string;
    baseImgUrl?: string;
    primaryImage?: string | { url?: string };
    image?: { url?: string };
    overrideUrl?: string;
    price?: {
        formattedAmount?: string;
        formattedValue?: string;
        centAmount?: number;
        currencyCode?: string;
    };
    listPrice?: {
        formattedAmount?: string;
        formattedValue?: string;
    };
    variant?: {
        id?: string;
        attributes?: {
            pieceCount?: number;
            minifigureCount?: number;
            rating?: { averageRating?: number; totalReviewCount?: number };
            featuredFlags?: string[];
            deliveryChannel?: string;
            canAddToBag?: boolean;
        };
    };
    attributes?: {
        pieceCount?: number;
        minifigureCount?: number;
        rating?: { averageRating?: number; totalReviewCount?: number };
        featuredFlags?: string[];
    };
    availability?: {
        canAddToBag?: boolean;
        deliveryChannel?: string;
        launchDate?: string;
    };
    themes?: Array<{ name?: string }>;
    badges?: Array<{ text?: string; type?: string }>;
    flags?: Array<{ text?: string; type?: string }>;
    [key: string]: unknown;
}

// Store captured products from API responses
const capturedProducts: Map<string, ApiProduct> = new Map();

// Parse API product data into our format
function parseApiProduct(apiProduct: ApiProduct, baseUrl: string): LegoProduct | null {
    try {
        const setNumber = apiProduct.productCode || apiProduct.id || '';
        if (!setNumber) return null;

        const name = apiProduct.name || '';

        // Get image URL
        let imageUrl = '';
        if (typeof apiProduct.primaryImage === 'string') {
            imageUrl = apiProduct.primaryImage;
        } else if (apiProduct.primaryImage?.url) {
            imageUrl = apiProduct.primaryImage.url;
        } else if (apiProduct.baseImgUrl) {
            imageUrl = apiProduct.baseImgUrl;
        } else if (apiProduct.image?.url) {
            imageUrl = apiProduct.image.url;
        }

        // Get price info
        const priceData = apiProduct.price;
        const price = priceData?.formattedAmount || priceData?.formattedValue ||
            (priceData?.centAmount ? `$${(priceData.centAmount / 100).toFixed(2)}` : null);

        const listPriceData = apiProduct.listPrice;
        const originalPrice = listPriceData?.formattedAmount || listPriceData?.formattedValue || null;

        // Get attributes (could be nested in variant or directly on product)
        const attrs = apiProduct.variant?.attributes || apiProduct.attributes || {};

        const pieces = attrs.pieceCount ?? null;
        const minifigures = attrs.minifigureCount ?? null;
        const rating = attrs.rating?.averageRating ?? null;
        const reviewCount = attrs.rating?.totalReviewCount ?? null;

        // Get availability
        let availability = 'Available';
        const avail = apiProduct.availability;
        const variantAttrs = apiProduct.variant?.attributes;
        if (avail) {
            if (avail.canAddToBag === false) {
                availability = 'Out of Stock';
            }
            if (avail.deliveryChannel === 'coming_soon' || avail.launchDate) {
                availability = 'Coming Soon';
            }
        } else if (variantAttrs) {
            if (variantAttrs.canAddToBag === false) {
                availability = 'Out of Stock';
            }
            if (variantAttrs.deliveryChannel === 'coming_soon') {
                availability = 'Coming Soon';
            }
        }

        // Get tags/badges/flags
        const tags: string[] = [];
        const featuredFlags = attrs.featuredFlags || [];
        tags.push(...featuredFlags);

        if (apiProduct.badges) {
            for (const badge of apiProduct.badges) {
                if (badge.text) tags.push(badge.text);
            }
        }
        if (apiProduct.flags) {
            for (const flag of apiProduct.flags) {
                if (flag.text) tags.push(flag.text);
            }
        }

        // Get theme
        let theme = '';
        if (apiProduct.themes && apiProduct.themes.length > 0) {
            theme = apiProduct.themes[0].name || '';
        }

        // Build product URL
        const slug = apiProduct.slug || apiProduct.overrideUrl || setNumber;
        const productUrl = slug.startsWith('http') ? slug : `${baseUrl}/product/${slug}`;

        return {
            setNumber,
            name,
            theme,
            pieces,
            minifigures,
            rating,
            reviewCount,
            price,
            originalPrice,
            availability,
            tags: [...new Set(tags)], // Remove duplicates
            imageUrl,
            productUrl,
            scrapedAt: new Date().toISOString(),
        };
    } catch (error) {
        log.warning(`Failed to parse API product: ${error}`);
        return null;
    }
}

// Process API response data
function processApiResponse(data: unknown): ApiProduct[] {
    const products: ApiProduct[] = [];

    function findProducts(obj: unknown, depth = 0): void {
        if (depth > 10 || !obj) return;

        if (Array.isArray(obj)) {
            for (const item of obj) {
                findProducts(item, depth + 1);
            }
        } else if (typeof obj === 'object' && obj !== null) {
            const record = obj as Record<string, unknown>;
            // Check if this looks like a product
            if (record.productCode || (record.id && record.name && (record.price || record.primaryImage))) {
                products.push(record as ApiProduct);
            } else {
                // Recurse into object properties
                for (const value of Object.values(record)) {
                    findProducts(value, depth + 1);
                }
            }
        }
    }

    findProducts(data);
    return products;
}

// Set up API interception
async function setupApiInterception(page: Page): Promise<void> {
    page.on('response', async (response: Response) => {
        const url = response.url();

        // Look for product-related API endpoints
        if (
            url.includes('/api/') ||
            url.includes('/graphql') ||
            url.includes('product') ||
            url.includes('catalog') ||
            url.includes('search')
        ) {
            try {
                const contentType = response.headers()['content-type'] || '';
                if (contentType.includes('application/json')) {
                    const text = await response.text();
                    const data = JSON.parse(text);

                    const products = processApiResponse(data);
                    for (const product of products) {
                        const key = product.productCode || product.id || '';
                        if (key && !capturedProducts.has(key)) {
                            capturedProducts.set(key, product);
                            log.debug(`Captured product from API: ${key}`);
                        }
                    }

                    if (products.length > 0) {
                        log.info(`Captured ${products.length} products from API response`);
                    }
                }
            } catch {
                // Ignore parsing errors for non-JSON responses
            }
        }
    });
}

// Helper function to scroll and load all products
async function scrollToLoadAllProducts(page: Page, maxProducts: number): Promise<number> {
    let previousProductCount = 0;
    let sameCountIterations = 0;
    const maxSameCountIterations = 5;

    while (sameCountIterations < maxSameCountIterations) {
        // Get current product count from either API captures or DOM
        const domProductCount = await page.locator('[data-test="product-item"], [data-test="product-leaf"], article[data-test*="product"], li[data-test*="product"]').count().catch(() => 0);
        const apiProductCount = capturedProducts.size;
        const currentProductCount = Math.max(domProductCount, apiProductCount);

        log.info(`Products loaded: ${currentProductCount} (DOM: ${domProductCount}, API: ${apiProductCount})`);

        // Check if we've reached max products limit
        if (maxProducts > 0 && currentProductCount >= maxProducts) {
            log.info(`Reached max products limit: ${maxProducts}`);
            break;
        }

        // Scroll down
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(2000);

        // Try to click "Load More" or pagination buttons
        const loadMoreSelectors = [
            'button[data-test="load-more"]',
            'button:has-text("Load more")',
            'button:has-text("Show more")',
            '[data-test="pagination-next"]',
            'button:has-text("Next")',
        ];

        for (const selector of loadMoreSelectors) {
            const button = page.locator(selector).first();
            if (await button.isVisible().catch(() => false)) {
                await button.click().catch(() => {});
                await page.waitForTimeout(3000);
                break;
            }
        }

        // Check if product count changed
        if (currentProductCount === previousProductCount) {
            sameCountIterations++;
        } else {
            sameCountIterations = 0;
        }

        previousProductCount = currentProductCount;
    }

    return capturedProducts.size;
}

// Extract product data from DOM as fallback
async function extractProductsFromDom(page: Page, maxProducts: number): Promise<LegoProduct[]> {
    const products: LegoProduct[] = [];

    // Try various selectors for product cards
    const selectors = [
        '[data-test="product-item"]',
        '[data-test="product-leaf"]',
        'article[data-test*="product"]',
        'li[data-test*="product"]',
        '[class*="ProductLeaf"]',
        '[class*="product-card"]',
    ];

    let productElements: ReturnType<Page['locator']> | null = null;
    for (const selector of selectors) {
        const elements = page.locator(selector);
        const count = await elements.count().catch(() => 0);
        if (count > 0) {
            productElements = elements;
            log.info(`Found ${count} products using selector: ${selector}`);
            break;
        }
    }

    if (!productElements) {
        log.warning('Could not find product elements in DOM');
        return products;
    }

    const count = await productElements.count();
    const limit = maxProducts > 0 ? Math.min(maxProducts, count) : count;

    for (let i = 0; i < limit; i++) {
        try {
            const element = productElements.nth(i);

            // Extract product link
            const link = await element.locator('a').first().getAttribute('href').catch(() => '') || '';

            // Skip non-product links (promotional banners, category links)
            if (!link.includes('/product/')) {
                continue;
            }

            // Try multiple patterns for set number:
            // 1. /product/set-name-12345 (number at end of slug after hyphen)
            // 2. /12345/ or /12345? (direct number in path)
            let setNumber = '';
            const slugMatch = link.match(/-(\d{4,6})(?:\?|$)/);
            const pathMatch = link.match(/\/(\d{5,6})(?:\?|$|\/)/);
            if (slugMatch) {
                setNumber = slugMatch[1];
            } else if (pathMatch) {
                setNumber = pathMatch[1];
            }

            // Extract name
            const name = await element.locator('h2, h3, [data-test*="title"], [class*="title"]').first().textContent().catch(() => '') || '';

            // Extract image
            const imageUrl = await element.locator('img').first().getAttribute('src').catch(() => '') || '';

            // Extract price
            const priceText = await element.locator('[data-test*="price"], [class*="price"]').first().textContent().catch(() => '') || '';
            const price = priceText.match(/\$[\d,.]+/)?.[0] || null;

            // Extract pieces
            const piecesText = await element.locator('[data-test*="piece"], [class*="piece"]').first().textContent().catch(() => '') || '';
            const piecesMatch = piecesText.match(/(\d+)/);
            const pieces = piecesMatch ? parseInt(piecesMatch[1], 10) : null;

            const productUrl = link.startsWith('http') ? link : `https://www.lego.com${link}`;

            if (name || setNumber) {
                products.push({
                    setNumber,
                    name: name.trim(),
                    theme: '',
                    pieces,
                    minifigures: null,
                    rating: null,
                    reviewCount: null,
                    price,
                    originalPrice: null,
                    availability: 'Available',
                    tags: [],
                    imageUrl,
                    productUrl,
                    scrapedAt: new Date().toISOString(),
                });
            }
        } catch (error) {
            log.warning(`Failed to extract product at index ${i}: ${error}`);
        }
    }

    return products;
}

// Main catalog handler
router.addHandler('CATALOG', async ({ page, request, log }) => {
    const { maxProducts = 0 } = request.userData;

    log.info(`Processing catalog page: ${request.url}`);

    // Set up API interception before navigating
    await setupApiInterception(page);

    // Wait for the page to load
    try {
        // Wait for product-related elements or network requests
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

        // Additional wait for dynamic content
        await page.waitForTimeout(5000);
    } catch (error) {
        log.warning(`Page load warning: ${error}`);
    }

    // Scroll to load all products
    log.info('Scrolling to load all products...');
    const apiProductCount = await scrollToLoadAllProducts(page, maxProducts);

    let products: LegoProduct[] = [];

    // First, try to use API-captured data
    if (capturedProducts.size > 0) {
        log.info(`Processing ${capturedProducts.size} products captured from API`);
        const baseUrl = new URL(request.url).origin;

        for (const apiProduct of capturedProducts.values()) {
            const product = parseApiProduct(apiProduct, baseUrl);
            if (product) {
                products.push(product);
            }

            if (maxProducts > 0 && products.length >= maxProducts) {
                break;
            }
        }
    }

    // Fallback to DOM extraction if API capture didn't work
    if (products.length === 0) {
        log.info('No API data captured, falling back to DOM extraction');
        products = await extractProductsFromDom(page, maxProducts);
    }

    log.info(`Successfully extracted ${products.length} products`);

    if (products.length === 0) {
        // Save debug information
        const screenshot = await page.screenshot({ fullPage: false });
        await Actor.setValue('debug-screenshot', screenshot, { contentType: 'image/png' });

        const html = await page.content();
        await Actor.setValue('debug-html', html, { contentType: 'text/html' });

        log.warning('No products found. Debug screenshot and HTML saved to key-value store.');
    } else {
        // Push products to dataset
        await Dataset.pushData(products);
    }
});

// Default handler for any other requests
router.addDefaultHandler(async ({ request, log }) => {
    log.info(`Handling default route for: ${request.url}`);
});

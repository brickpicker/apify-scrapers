import { Actor } from 'apify';
import { createPlaywrightRouter, Dataset, log } from 'crawlee';
import type { Page } from 'playwright';

export const router = createPlaywrightRouter();

interface LegoProduct {
    setNumber: string;
    name: string;
    theme: string;
    pieces: number | null;
    minifigures: number | null;
    ageRange: string | null;
    rating: number | null;
    reviewCount: number | null;
    retailPrice: string | null;
    salePrice: string | null;
    isOnSale: boolean;
    discountPercentage: number | null;
    availability: string;
    tags: string[];
    imageUrl: string;
    productUrl: string;
    scrapedAt: string;
}

// Helper function to scroll and load all products in catalog
async function scrollToLoadAllProducts(page: Page, maxProducts: number): Promise<void> {
    let previousProductCount = 0;
    let sameCountIterations = 0;
    const maxSameCountIterations = 10;
    let totalScrolls = 0;
    const maxTotalScrolls = 500;

    while (sameCountIterations < maxSameCountIterations && totalScrolls < maxTotalScrolls) {
        totalScrolls++;

        const currentProductCount = await page.locator('[data-test="product-item"]').count().catch(() => 0);

        if (totalScrolls % 10 === 0 || currentProductCount - previousProductCount > 20) {
            log.info(`Products loaded: ${currentProductCount} [scroll ${totalScrolls}]`);
        }

        if (maxProducts > 0 && currentProductCount >= maxProducts) {
            log.info(`Reached max products limit: ${maxProducts}`);
            break;
        }

        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1500);

        // Try to click "Load More" buttons
        const loadMoreSelectors = [
            'button[data-test="load-more"]',
            'button:has-text("Load more")',
            'button:has-text("Show more")',
            'button:has-text("View more")',
        ];

        let clickedButton = false;
        for (const selector of loadMoreSelectors) {
            const button = page.locator(selector).first();
            if (await button.isVisible().catch(() => false)) {
                log.info(`Clicking: ${selector}`);
                await button.click().catch(() => {});
                await page.waitForTimeout(3000);
                clickedButton = true;
                break;
            }
        }

        if (clickedButton) {
            sameCountIterations = 0;
        } else if (currentProductCount === previousProductCount) {
            sameCountIterations++;
        } else {
            sameCountIterations = 0;
        }

        previousProductCount = currentProductCount;
    }

    log.info(`Finished loading. Total scrolls: ${totalScrolls}, Products: ${previousProductCount}`);
}

// CATALOG handler - collects all product URLs and enqueues them
router.addHandler('CATALOG', async ({ page, request, crawler, log }) => {
    const { maxProducts = 0 } = request.userData;

    log.info(`Processing catalog: ${request.url}`);

    // Wait for products to load
    try {
        await page.waitForSelector('[data-test="product-item"]', { timeout: 30000 });
    } catch {
        log.error('No products found on catalog page');
        const screenshot = await page.screenshot({ fullPage: false });
        await Actor.setValue('debug-catalog-screenshot', screenshot, { contentType: 'image/png' });
        return;
    }

    // Scroll to load all products
    await scrollToLoadAllProducts(page, maxProducts);

    // Extract all product URLs
    const productItems = page.locator('[data-test="product-item"]');
    const count = await productItems.count();
    const limit = maxProducts > 0 ? Math.min(maxProducts, count) : count;

    log.info(`Found ${count} products, will process ${limit}`);

    const productUrls: string[] = [];
    for (let i = 0; i < limit; i++) {
        const item = productItems.nth(i);
        const link = await item.locator('a').first().getAttribute('href').catch(() => '');

        if (link && link.includes('/product/')) {
            const fullUrl = link.startsWith('http') ? link : `https://www.lego.com${link}`;
            productUrls.push(fullUrl);
        }
    }

    log.info(`Enqueuing ${productUrls.length} product pages for detailed scraping`);

    // Enqueue all product pages
    await crawler.addRequests(
        productUrls.map(url => ({
            url,
            label: 'PRODUCT',
        }))
    );
});

// PRODUCT handler - extracts full details from product page
router.addHandler('PRODUCT', async ({ page, request, log }) => {
    log.info(`Processing product: ${request.url}`);

    // Wait for product page to load
    try {
        await page.waitForSelector('[data-test="product-overview-name"], h1[class*="ProductName"]', { timeout: 20000 });
    } catch {
        log.warning(`Could not load product page: ${request.url}`);
        return;
    }

    // Give page time to fully render
    await page.waitForTimeout(2000);

    // Extract set number from URL
    const urlMatch = request.url.match(/-(\d{4,6})(?:\?|$)/);
    const setNumber = urlMatch ? urlMatch[1] : '';

    // Extract product name
    const name = await page.locator('[data-test="product-overview-name"], h1[class*="ProductName"]').first().textContent().catch(() => '') || '';

    // Extract theme from breadcrumbs or page
    let theme = '';
    const breadcrumbs = page.locator('[data-test="breadcrumb-item"], nav[aria-label="Breadcrumb"] a, [class*="Breadcrumb"] a');
    const breadcrumbCount = await breadcrumbs.count();
    if (breadcrumbCount > 1) {
        // Theme is usually the second-to-last breadcrumb
        theme = await breadcrumbs.nth(breadcrumbCount - 2).textContent().catch(() => '') || '';
    }

    // Extract price information
    let retailPrice: string | null = null;
    let salePrice: string | null = null;
    let isOnSale = false;
    let discountPercentage: number | null = null;

    // Try to find sale price first (the current/discounted price)
    const salePriceElement = page.locator('[data-test="product-price-sale"], [class*="SalePrice"], [class*="sale-price"]').first();
    const salePriceText = await salePriceElement.textContent().catch(() => '') || '';
    const salePriceMatch = salePriceText.match(/\$[\d,.]+/);

    // Try to find original/retail price (usually struck through when on sale)
    const originalPriceElement = page.locator('[data-test="product-price-original"], [class*="OriginalPrice"], [class*="original-price"], s:has-text("$"), del:has-text("$")').first();
    const originalPriceText = await originalPriceElement.textContent().catch(() => '') || '';
    const originalPriceMatch = originalPriceText.match(/\$[\d,.]+/);

    // Try to find the main price display
    const mainPriceText = await page.locator('[data-test="product-price"], [class*="ProductPrice"]').first().textContent().catch(() => '') || '';
    const allPrices = mainPriceText.match(/\$[\d,.]+/g) || [];

    // Try to find discount percentage
    const discountText = await page.locator('[data-test*="discount"], [class*="Discount"], [class*="savings"]').first().textContent().catch(() => '') || '';
    const discountMatch = discountText.match(/(\d+)%?/) || mainPriceText.match(/-(\d+)%/);

    if (originalPriceMatch && salePriceMatch) {
        // We have both original and sale price
        retailPrice = originalPriceMatch[0];
        salePrice = salePriceMatch[0];
        isOnSale = true;
    } else if (allPrices.length >= 2 && allPrices[0] && allPrices[1]) {
        // Multiple prices in main price area - first is usually sale, second is original
        // Or check which is higher
        const price1 = parseFloat(allPrices[0].replace(/[$,]/g, ''));
        const price2 = parseFloat(allPrices[1].replace(/[$,]/g, ''));
        if (price1 < price2) {
            salePrice = allPrices[0] ?? null;
            retailPrice = allPrices[1] ?? null;
            isOnSale = true;
        } else if (price2 < price1) {
            salePrice = allPrices[1] ?? null;
            retailPrice = allPrices[0] ?? null;
            isOnSale = true;
        } else {
            retailPrice = allPrices[0] ?? null;
        }
    } else if (salePriceMatch) {
        salePrice = salePriceMatch[0];
        retailPrice = originalPriceMatch ? originalPriceMatch[0] : null;
        isOnSale = !!originalPriceMatch;
    } else if (allPrices.length === 1 && allPrices[0]) {
        retailPrice = allPrices[0];
    }

    // Calculate discount percentage if we have both prices
    if (isOnSale && retailPrice && salePrice) {
        const retail = parseFloat(retailPrice.replace(/[$,]/g, ''));
        const sale = parseFloat(salePrice.replace(/[$,]/g, ''));
        if (retail > 0 && sale < retail) {
            discountPercentage = Math.round(((retail - sale) / retail) * 100);
        }
    } else if (discountMatch) {
        discountPercentage = parseInt(discountMatch[1], 10);
        isOnSale = discountPercentage > 0;
    }

    // If on sale, add Sale tag
    if (isOnSale) {
        // Will add to tags later
    }

    // Extract pieces count
    const piecesText = await page.locator('[data-test="product-piece-count"], [class*="Pieces"], span:has-text("Pieces")').first().textContent().catch(() => '') || '';
    const piecesMatch = piecesText.match(/(\d+)/);
    const pieces = piecesMatch ? parseInt(piecesMatch[1], 10) : null;

    // Extract minifigures count
    const minifigsText = await page.locator('[data-test="product-minifig-count"], [class*="Minifig"], span:has-text("Minifigure")').first().textContent().catch(() => '') || '';
    const minifigsMatch = minifigsText.match(/(\d+)/);
    const minifigures = minifigsMatch ? parseInt(minifigsMatch[1], 10) : null;

    // Extract age range
    const ageText = await page.locator('[data-test="product-age"], [class*="Age"], span:has-text("Ages")').first().textContent().catch(() => '') || '';
    const ageRange = ageText.trim() || null;

    // Extract rating
    const ratingElement = page.locator('[data-test="product-overview-rating"], [class*="Rating"]').first();
    const ratingLabel = await ratingElement.getAttribute('aria-label').catch(() => '') || '';
    const ratingText = await ratingElement.textContent().catch(() => '') || '';
    const ratingMatch = ratingLabel.match(/([\d.]+)\s*(?:out of|\/)\s*5/) || ratingText.match(/([\d.]+)/);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

    // Extract review count
    const reviewText = await page.locator('[data-test="product-review-count"], [class*="ReviewCount"], a:has-text("review")').first().textContent().catch(() => '') || '';
    const reviewMatch = reviewText.match(/(\d+)/);
    const reviewCount = reviewMatch ? parseInt(reviewMatch[1], 10) : null;

    // Extract availability/stock status
    let availability = 'Available';
    const pageContent = await page.content();
    const pageContentLower = pageContent.toLowerCase();

    // Check for various stock statuses
    const addToBagButton = page.locator('button[data-test="add-to-bag"], button:has-text("Add to Bag"), button:has-text("Add to Cart")').first();
    const isAddToBagVisible = await addToBagButton.isVisible().catch(() => false);
    const isAddToBagDisabled = await addToBagButton.isDisabled().catch(() => true);

    if (!isAddToBagVisible || isAddToBagDisabled) {
        if (pageContentLower.includes('sold out') || pageContentLower.includes('out of stock')) {
            availability = 'Out of Stock';
        } else if (pageContentLower.includes('coming soon')) {
            availability = 'Coming Soon';
        } else if (pageContentLower.includes('temporarily out of stock')) {
            availability = 'Temporarily Out of Stock';
        } else if (pageContentLower.includes('backorder')) {
            availability = 'Backorder';
        }
    }

    // Check for availability messaging
    const availabilityText = await page.locator('[data-test="product-availability"], [class*="Availability"], [class*="StockStatus"]').first().textContent().catch(() => '') || '';
    if (availabilityText) {
        const availLower = availabilityText.toLowerCase();
        if (availLower.includes('sold out') || availLower.includes('out of stock')) {
            availability = 'Out of Stock';
        } else if (availLower.includes('coming soon')) {
            availability = 'Coming Soon';
        } else if (availLower.includes('back order') || availLower.includes('backorder')) {
            availability = 'Backorder';
        } else if (availLower.includes('available')) {
            availability = 'Available';
        }
    }

    // Extract tags (Retiring Soon, Exclusive, New, Hard to Find, etc.)
    const tags: string[] = [];

    // Valid tag patterns we're looking for
    const validTagPatterns = [
        /retiring soon/i,
        /exclusive/i,
        /new/i,
        /hard to find/i,
        /sale/i,
        /limited edition/i,
        /insider/i,
        /vip/i,
        /coming soon/i,
        /back in stock/i,
        /bestseller/i,
        /best seller/i,
    ];

    // Check for badges/flags only in the main product section (not carousels)
    const mainProductSection = page.locator('[data-test="product-overview"], [class*="ProductOverview"], main').first();
    const badgeSelectors = [
        '[data-test*="badge"]',
        '[data-test*="flag"]',
    ];

    for (const selector of badgeSelectors) {
        const badges = mainProductSection.locator(selector);
        const badgeCount = await badges.count();
        for (let i = 0; i < Math.min(badgeCount, 10); i++) { // Limit to avoid noise
            const badgeText = await badges.nth(i).textContent().catch(() => '') || '';
            const trimmed = badgeText.trim();
            // Only add if it matches a valid tag pattern and is reasonably short
            if (trimmed && trimmed.length < 30 && validTagPatterns.some(p => p.test(trimmed))) {
                if (!tags.includes(trimmed)) {
                    tags.push(trimmed);
                }
            }
        }
    }

    // Check page content for specific tags (more reliable)
    if (pageContentLower.includes('retiring soon') && !tags.some(t => t.toLowerCase().includes('retiring'))) {
        tags.push('Retiring Soon');
    }
    if ((pageContentLower.includes('lego exclusive') || pageContentLower.includes('lego® exclusive'))
        && !tags.some(t => t.toLowerCase().includes('exclusive'))) {
        tags.push('Exclusive');
    }
    if (pageContentLower.includes('hard to find') && !tags.some(t => t.toLowerCase().includes('hard to find'))) {
        tags.push('Hard to Find');
    }
    if ((pageContentLower.includes('insider exclusive') || pageContentLower.includes('vip exclusive'))
        && !tags.some(t => t.toLowerCase().includes('insider') || t.toLowerCase().includes('vip'))) {
        tags.push('Insider Exclusive');
    }
    // Check if it's a new product (launched recently)
    if (pageContentLower.includes('>new<') || pageContentLower.includes('"new"')) {
        if (!tags.includes('New')) {
            tags.push('New');
        }
    }

    // Add Sale tag if on sale
    if (isOnSale && !tags.some(t => t.toLowerCase() === 'sale')) {
        tags.push('Sale');
    }

    // Extract main product image
    const imageElement = page.locator('[data-test="product-image"] img, [class*="ProductImage"] img, picture img').first();
    let imageUrl = await imageElement.getAttribute('src').catch(() => '') || '';
    if (!imageUrl) {
        imageUrl = await imageElement.getAttribute('data-src').catch(() => '') || '';
    }

    const product: LegoProduct = {
        setNumber,
        name: name.trim(),
        theme: theme.trim(),
        pieces,
        minifigures,
        ageRange,
        rating,
        reviewCount,
        retailPrice,
        salePrice,
        isOnSale,
        discountPercentage,
        availability,
        tags: [...new Set(tags)], // Remove duplicates
        imageUrl,
        productUrl: request.url,
        scrapedAt: new Date().toISOString(),
    };

    log.info(`Extracted: ${setNumber} - ${name} | ${availability} | ${tags.join(', ') || 'no tags'}`);

    await Dataset.pushData(product);
});

// Default handler
router.addDefaultHandler(async ({ request, log }) => {
    log.info(`Unhandled route: ${request.url}`);
});

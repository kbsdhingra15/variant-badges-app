/**
 * Variant Badges - Storefront Script (Scalable Version)
 * Only loads badges for current product
 */

(function () {
  "use strict";

  const BADGE_STYLES = {
    HOT: { emoji: "🔥", text: "HOT", color: "#ff4444" },
    NEW: { emoji: "✨", text: "NEW", color: "#4CAF50" },
    SALE: { emoji: "💰", text: "SALE", color: "#FF9800" },
  };

  let badgeData = {};
  let appUrl = null;
  let shopDomain = null;
  let productId = null;

  // Initialize when DOM is ready
  function init() {
    // Get shop domain from Shopify global
    shopDomain = window.Shopify?.shop || null;

    if (!shopDomain) {
      console.error("Variant Badges: Shop domain not found");
      return;
    }

    // Get product ID from Shopify Analytics
    productId =
      window.ShopifyAnalytics?.meta?.product?.id ||
      window.ShopifyAnalytics?.meta?.product?.gid?.split("/").pop();

    if (!productId) {
      console.error("Variant Badges: Product ID not found");
      return;
    }

    // Get app URL
    const metaTag = document.querySelector(
      'meta[name="variant-badges-app-url"]'
    );
    appUrl =
      metaTag?.content ||
      "https://variant-badges-app-production.up.railway.app";

    console.log("✅ Variant Badges initialized:", { productId, shopDomain });

    // Load badge data for this product only
    loadBadgeData();

    // Watch for variant changes
    observeVariantChanges();
  }

  // Load badge data from API (product-specific)
  async function loadBadgeData() {
    try {
      const response = await fetch(
        `${appUrl}/api/public/badges/product/${productId}?shop=${shopDomain}`
      );

      if (!response.ok) {
        console.error("Variant Badges: Failed to load badge data");
        return;
      }

      const data = await response.json();
      badgeData = data.badges || {};

      console.log(
        "✅ Variant Badges loaded:",
        Object.keys(badgeData).length,
        "badges for this product"
      );

      // Apply badges to current page
      applyBadges();
    } catch (error) {
      console.error("Variant Badges: Error loading data:", error);
    }
  }

  // Apply badges to variant swatches
  function applyBadges() {
    // Find all variant option buttons/swatches
    const variantSelectors = [
      'variant-radios input[type="radio"]',
      "variant-selects select option",
      ".product-form__input input",
      '[name^="options"]',
      "[data-variant-id]",
    ];

    variantSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        const variantId = element.value || element.dataset.variantId;

        if (variantId && badgeData[variantId]) {
          addBadgeToElement(element, badgeData[variantId]);
        }
      });
    });
  }

  // Add badge overlay to an element
  function addBadgeToElement(element, badgeType) {
    const badge = BADGE_STYLES[badgeType];
    if (!badge) return;

    // Find the visual element
    let targetElement = element;

    if (element.tagName === "INPUT") {
      const label = document.querySelector(`label[for="${element.id}"]`);
      targetElement = label || element.parentElement;
    } else if (element.tagName === "OPTION") {
      return; // Skip dropdowns
    }

    // Check if badge already exists
    if (targetElement.querySelector(".variant-badge-overlay")) return;

    // Create badge element
    const badgeEl = document.createElement("span");
    badgeEl.className = "variant-badge-overlay";
    badgeEl.textContent = badge.emoji + " " + badge.text;
    badgeEl.style.cssText = `
        position: absolute;
        top: 4px;
        right: 4px;
        background: ${badge.color};
        color: white;
        font-size: 10px;
        font-weight: bold;
        padding: 2px 6px;
        border-radius: 4px;
        z-index: 10;
        pointer-events: none;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      `;

    // Make parent relative
    const parentStyle = window.getComputedStyle(targetElement);
    if (parentStyle.position === "static") {
      targetElement.style.position = "relative";
    }

    targetElement.appendChild(badgeEl);
  }

  // Watch for dynamic changes
  function observeVariantChanges() {
    const observer = new MutationObserver(() => {
      applyBadges();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // Start when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

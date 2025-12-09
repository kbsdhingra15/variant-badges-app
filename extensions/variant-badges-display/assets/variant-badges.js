/**
 * Variant Badges - Theme App Extension
 * Production version with proper Shopify integration
 */

(function () {
  "use strict";

  const BADGE_STYLES = {
    HOT: { emoji: "🔥", text: "HOT", color: "#ff4444" },
    NEW: { emoji: "✨", text: "NEW", color: "#4CAF50" },
    SALE: { emoji: "💰", text: "SALE", color: "#FF9800" },
  };

  let badgeData = {};
  let variantMap = {};
  let config = {
    appUrl: "",
    shopDomain: "",
    productId: null,
    enabled: true,
    position: "top-right",
  };

  function init() {
    // Get configuration
    const container = document.querySelector(".variant-badges-container");
    if (!container) return;

    config.enabled = container.dataset.enabled !== "false";
    config.position = container.dataset.position || "top-right";

    if (!config.enabled) return;

    config.shopDomain = window.Shopify?.shop;
    config.productId = window.ShopifyAnalytics?.meta?.product?.id;

    const metaTag = document.querySelector(
      'meta[name="variant-badges-app-url"]'
    );
    config.appUrl =
      metaTag?.content ||
      "https://variant-badges-app-production.up.railway.app";

    if (!config.shopDomain || !config.productId) {
      return;
    }

    loadBadgeData();
  }

  async function loadBadgeData() {
    try {
      const response = await fetch(
        `${config.appUrl}/api/public/badges/product/${config.productId}?shop=${config.shopDomain}`
      );

      if (!response.ok) return;

      const data = await response.json();
      badgeData = data.badges || {};

      buildVariantMap();
      applyBadges();
      observeVariantChanges();
    } catch (error) {
      console.error("Variant Badges error:", error);
    }
  }

  function buildVariantMap() {
    const variants = window.ShopifyAnalytics?.meta?.product?.variants || [];
    variantMap = {};

    variants.forEach((v) => {
      if (!v.public_title || !v.id) return;

      const parts = v.public_title.split(" / ").map((s) => s.trim());

      parts.forEach((part) => {
        if (!variantMap[part]) {
          variantMap[part] = [];
        }
        const idStr = v.id.toString();
        if (!variantMap[part].includes(idStr)) {
          variantMap[part].push(idStr);
        }
      });
    });
  }

  function applyBadges() {
    const inputs = document.querySelectorAll(
      'input[type="radio"][id*="template"], input[type="radio"][name*="option"]'
    );

    if (inputs.length === 0) return;

    inputs.forEach((input) => {
      const optionValue = input.value;
      const variantIds = variantMap[optionValue] || [];

      let badgeToShow = null;
      for (const variantId of variantIds) {
        if (badgeData[variantId]) {
          badgeToShow = badgeData[variantId];
          break;
        }
      }

      let label = null;
      if (input.parentElement?.tagName === "LABEL") {
        label = input.parentElement;
      } else if (input.nextElementSibling?.tagName === "LABEL") {
        label = input.nextElementSibling;
      } else {
        label =
          input.closest("label") ||
          document.querySelector(`label[for="${input.id}"]`);
      }

      if (!label) return;

      const existingBadge = label.querySelector(".variant-badge-overlay");

      if (badgeToShow) {
        if (existingBadge) {
          const expectedText =
            BADGE_STYLES[badgeToShow].emoji +
            " " +
            BADGE_STYLES[badgeToShow].text;
          if (existingBadge.textContent === expectedText) {
            return;
          }
          existingBadge.remove();
        }
        addBadgeToElement(label, badgeToShow);
      } else if (existingBadge) {
        existingBadge.remove();
      }
    });
  }

  function addBadgeToElement(element, badgeType) {
    const badge = BADGE_STYLES[badgeType];
    if (!badge || element.querySelector(".variant-badge-overlay")) return;

    const badgeEl = document.createElement("span");
    badgeEl.className = `variant-badge-overlay badge-${config.position}`;
    badgeEl.textContent = badge.emoji + " " + badge.text;
    badgeEl.style.backgroundColor = badge.color;

    if (window.getComputedStyle(element).position === "static") {
      element.style.position = "relative";
    }

    element.appendChild(badgeEl);
  }

  function observeVariantChanges() {
    // Listen for variant changes
    document.addEventListener("change", (e) => {
      if (e.target.matches('input[type="radio"]')) {
        setTimeout(() => applyBadges(), 100);
      }
    });

    // Observe DOM changes
    const observer = new MutationObserver(() => {
      setTimeout(() => applyBadges(), 100);
    });

    const productForm = document.querySelector(
      'product-form, variant-radios, [class*="product"]'
    );
    if (productForm) {
      observer.observe(productForm, {
        childList: true,
        subtree: true,
      });
    }
  }

  // Initialize when ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose for Shopify theme editor
  if (window.Shopify && window.Shopify.designMode) {
    document.addEventListener("shopify:section:load", init);
  }
})();

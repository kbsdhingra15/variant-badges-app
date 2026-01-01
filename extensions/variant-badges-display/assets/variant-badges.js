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
  // ============================================
  // ANALYTICS TRACKING
  // ============================================

  // Generate unique session ID
  function getSessionId() {
    try {
      let sessionId = sessionStorage.getItem("vb_session");
      if (!sessionId) {
        sessionId =
          "vb_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
        sessionStorage.setItem("vb_session", sessionId);
      }
      return sessionId;
    } catch {
      return "vb_" + Date.now();
    }
  }

  // Track events (fire and forget)
  function trackEvent(eventType, variantId, badgeType, optionValue) {
    if (!config.shopDomain || !config.appUrl) return;

    const data = {
      shop: config.shopDomain,
      product_id: config.productId,
      variant_id: variantId,
      badge_type: badgeType,
      option_value: optionValue,
      event_type: eventType,
      session_id: getSessionId(),
    };

    fetch(`${config.appUrl}/api/analytics/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      keepalive: true,
    }).catch(() => {});
  }

  // ← ADD THIS NEW FUNCTION HERE
  // Track add to cart events
  // Track add to cart events
  function initAddToCartTracking() {
    // Try multiple form selectors
    const selectors = [
      'form[action*="/cart/add"]',
      'form[action="/cart/add"]',
      ".product-form",
      "form#product-form",
    ];

    let form = null;
    for (const selector of selectors) {
      form = document.querySelector(selector);
      if (form) {
        console.log("Found cart form:", selector);
        break;
      }
    }

    if (!form) {
      console.log("No add-to-cart form found");
      return;
    }

    form.addEventListener("submit", function () {
      console.log("Form submitted!");

      // Try multiple ways to get variant ID
      let variantId = null;

      // Method 1: Hidden input named "id"
      const variantInput = form.querySelector('[name="id"]');
      if (variantInput) {
        variantId = variantInput.value;
      }

      // Method 2: Selected radio option
      if (!variantId) {
        const selectedRadio = form.querySelector('input[type="radio"]:checked');
        if (selectedRadio) {
          variantId = selectedRadio.dataset.variantId || selectedRadio.value;
        }
      }

      console.log("Variant ID:", variantId);
      console.log("Badge data:", badgeData[variantId]);

      if (variantId && badgeData[variantId]) {
        const badge = badgeData[variantId];
        const badgeType = typeof badge === "string" ? badge : badge.badge_type;
        const optionValue =
          typeof badge === "string" ? null : badge.option_value;

        console.log("Tracking add-to-cart:", badgeType, optionValue);
        trackEvent("add_to_cart", variantId, badgeType, optionValue);
      }
    });
  }

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

    // ← ADD THIS LINE AT THE END
    initAddToCartTracking();
  }
  async function loadBadgeData() {
    try {
      const response = await fetch(
        `${config.appUrl}/api/public/badges/product/${config.productId}?shop=${config.shopDomain}`
      );

      if (!response.ok) return;

      const data = await response.json();
      badgeData = data.badges || {};
      config.selectedOption = data.selectedOption;

      // Track badge views - only once per unique badge type
      const trackedBadges = new Set();
      Object.keys(badgeData).forEach((variantId) => {
        const badge = badgeData[variantId];
        const badgeType = typeof badge === "string" ? badge : badge.badge_type;
        const optionValue =
          typeof badge === "string" ? null : badge.option_value;

        // Only track if we haven't tracked this badge type yet
        const trackingKey = `${badgeType}-${optionValue}`;
        if (!trackedBadges.has(trackingKey)) {
          trackedBadges.add(trackingKey);
          trackEvent("view", variantId, badgeType, optionValue);
        }
      });

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
    if (!config.selectedOption) {
      console.log("Variant Badges: No selected option configured");
      return;
    }
    // Find all radio inputs for product options
    const selectors = [
      'input[type="radio"][id*="template"]',
      'input[type="radio"][name*="option"]',
      'input[type="radio"][name^="options"]',
      '.product-form__input input[type="radio"]',
      'fieldset input[type="radio"]',
    ];

    let inputs = [];
    for (const selector of selectors) {
      const found = document.querySelectorAll(selector);
      if (found.length > 0) {
        inputs = found;
        break;
      }
    }

    if (inputs.length === 0) {
      console.log("Variant Badges: No radio inputs found");
      return;
    }

    inputs.forEach((input) => {
      // CRITICAL: Find the fieldset/option group this input belongs to
      const fieldset =
        input.closest("fieldset") || input.closest(".product-form__input");
      if (!fieldset) return;

      // Get the option name from legend or label
      const legend = fieldset.querySelector("legend");
      const optionName = legend ? legend.textContent.trim() : "";

      // Only process if this matches the selected option type
      if (optionName !== config.selectedOption) {
        return; // Skip this option group (Size, Fabric, etc.)
      }
      const optionValue = input.value;
      const variantIds = variantMap[optionValue] || [];

      let badgeToShow = null;
      for (const variantId of variantIds) {
        if (badgeData[variantId]) {
          badgeToShow = badgeData[variantId];
          break;
        }
      }

      // Find label - try multiple methods
      let label = null;

      // Method 1: Parent is label
      if (input.parentElement?.tagName === "LABEL") {
        label = input.parentElement;
      }

      // Method 2: Next sibling is label
      if (!label && input.nextElementSibling?.tagName === "LABEL") {
        label = input.nextElementSibling;
      }

      // Method 3: Closest label
      if (!label) {
        label = input.closest("label");
      }

      // Method 4: Label with for attribute
      if (!label && input.id) {
        label = document.querySelector(`label[for="${input.id}"]`);
      }

      // Method 5: Previous sibling is label
      if (!label && input.previousElementSibling?.tagName === "LABEL") {
        label = input.previousElementSibling;
      }

      if (!label) return;

      // Check if badge already exists with correct type
      const existingBadge = label.querySelector(".variant-badge-overlay");

      if (badgeToShow) {
        const badgeType =
          typeof badgeToShow === "string"
            ? badgeToShow
            : badgeToShow.badge_type;
        const badgeStyle = BADGE_STYLES[badgeType.toUpperCase()];
        if (!badgeStyle) return; // Skip if badge type not found

        const expectedText = badgeStyle.emoji + " " + badgeStyle.text;

        // Only update if badge doesn't exist or is wrong type
        if (!existingBadge || existingBadge.textContent !== expectedText) {
          if (existingBadge) existingBadge.remove();
          addBadgeToElement(label, badgeType.toUpperCase());
        }
      } else if (existingBadge) {
        existingBadge.remove();
      }
    });
  }

  function addBadgeToElement(element, badgeType) {
    const badge = BADGE_STYLES[badgeType.toUpperCase()];
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
    let isInitialized = false;
    let applyTimeout = null;

    // Wait for initial render to complete
    setTimeout(() => {
      isInitialized = true;
    }, 1000);
    // Listen for variant changes
    document.addEventListener("change", (e) => {
      if (e.target.matches('input[type="radio"]') && isInitialized) {
        // Only track if this is the selected option type (e.g., Color, not Size)
        const fieldset =
          e.target.closest("fieldset") ||
          e.target.closest(".product-form__input");
        if (fieldset) {
          const legend = fieldset.querySelector("legend");
          const optionName = legend ? legend.textContent.trim() : "";

          // Only track clicks on the badged option type
          if (optionName === config.selectedOption) {
            const optionValue = e.target.value;
            const variantIds = variantMap[optionValue] || [];

            // Check if any of these variants have a badge
            for (const variantId of variantIds) {
              if (badgeData[variantId]) {
                const badge = badgeData[variantId];
                const badgeType =
                  typeof badge === "string" ? badge : badge.badge_type;
                const optVal =
                  typeof badge === "string" ? optionValue : badge.option_value;
                trackEvent("click", variantId, badgeType, optVal);
                break; // Only track once
              }
            }
          }
        }

        // Clear any pending re-apply
        if (applyTimeout) clearTimeout(applyTimeout);

        // Wait for DOM to fully settle before re-applying
        applyTimeout = setTimeout(() => {
          console.log("Variant Badges: Re-applying after variant change");
          applyBadges();
        }, 500);
      }
    });

    // Watch for product form rebuilds (less aggressive)
    const observer = new MutationObserver((mutations) => {
      if (!isInitialized) return; // Skip during initial load

      // Only react to significant changes (fieldset added/removed)
      const significantChange = mutations.some(
        (m) =>
          m.type === "childList" &&
          Array.from(m.addedNodes).some(
            (node) =>
              node.nodeName === "FIELDSET" ||
              (node.classList && node.classList.contains("product-form__input"))
          )
      );

      if (significantChange) {
        if (applyTimeout) clearTimeout(applyTimeout);
        applyTimeout = setTimeout(() => {
          console.log("Variant Badges: Re-applying after DOM rebuild");
          applyBadges();
        }, 500);
      }
    });

    // Watch only the variant selectors container, not entire form
    const variantSelectors =
      document.querySelector(".product-form__controls") ||
      document.querySelector("variant-radios") ||
      document.querySelector(".product-form");

    if (variantSelectors) {
      observer.observe(variantSelectors, {
        childList: true,
        subtree: false, // Only direct children, not deep
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

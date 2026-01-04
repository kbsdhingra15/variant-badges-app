const { checkPlanLimits } = require("../middleware/planLimits");
const express = require("express");
const router = express.Router();
const {
  getBadgeAssignments,
  saveBadgeAssignment,
  deleteBadgeAssignment,
  getAppSettings,
  pool,
} = require("../database/db");

// ========== NEW PAGINATION ENDPOINT ==========
// This is a NEW endpoint - existing /all-products stays untouched
// ========== PAGINATION ENDPOINT - PAGINATE OPTION GROUPS (ROWS) ==========
router.get("/paginated", async (req, res) => {
  try {
    const shop = req.shop;
    const { accessToken } = req.shopifySession;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || "";

    console.log(
      `📦 [PAGINATION] Page ${page}, Limit ${limit}, Search: "${search}"`
    );

    // Get settings
    const settings = await getAppSettings(shop);
    const selectedOption = settings.selectedOption;

    if (!selectedOption) {
      return res.json({
        products: [],
        badges: {},
        selectedOption: null,
        totalRows: 0,
        currentPage: page,
        totalPages: 0,
        hasMore: false,
      });
    }

    // Fetch ALL products to build complete option groups list
    const query = `
      query getProducts($first: Int!, $query: String) {
        products(first: $first, query: $query) {
          edges {
            node {
              id
              title
              handle
              featuredImage {
                url
                altText
              }
              options {
                name
                values
              }
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    displayName
                    selectedOptions {
                      name
                      value
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const variables = {
      first: 250, // Fetch enough products
      query: search ? `title:*${search}*` : null,
    };

    const graphqlUrl = `https://${shop}/admin/api/2024-10/graphql.json`;
    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    const productsData = await response.json();

    if (productsData.errors) {
      console.error("GraphQL errors:", productsData.errors);
      throw new Error("GraphQL query failed");
    }

    const allProducts = productsData.data.products.edges.map((edge) => ({
      id: edge.node.id.split("/").pop(),
      title: edge.node.title,
      handle: edge.node.handle,
      image: edge.node.featuredImage?.url,
      options: edge.node.options,
      variants: edge.node.variants.edges.map((v) => ({
        id: v.node.id.split("/").pop(),
        title: v.node.title,
        displayName: v.node.displayName,
        selectedOptions: v.node.selectedOptions,
      })),
    }));

    // Build ALL rows (product + option value combinations)
    const allRows = [];

    allProducts.forEach((product) => {
      const selectedOptionData = product.options.find(
        (opt) => opt.name === selectedOption
      );

      if (!selectedOptionData) return;

      // For each option value in this product, create a row
      const optionValuesInProduct = new Set();

      product.variants.forEach((variant) => {
        const selectedOpt = variant.selectedOptions?.find(
          (opt) => opt.name === selectedOption
        );
        if (selectedOpt) {
          optionValuesInProduct.add(selectedOpt.value);
        }
      });

      // Create one row per unique option value in this product
      optionValuesInProduct.forEach((optionValue) => {
        const variantsWithThisOption = product.variants.filter((variant) => {
          const selectedOpt = variant.selectedOptions?.find(
            (opt) => opt.name === selectedOption
          );
          return selectedOpt && selectedOpt.value === optionValue;
        });

        allRows.push({
          productId: product.id,
          productTitle: product.title,
          productHandle: product.handle,
          productImage: product.image,
          optionValue: optionValue,
          variantIds: variantsWithThisOption.map((v) => v.id),
          variantCount: variantsWithThisOption.length,
        });
      });
    });

    // Sort rows alphabetically by product title, then option value
    allRows.sort((a, b) => {
      const titleCompare = a.productTitle.localeCompare(b.productTitle);
      if (titleCompare !== 0) return titleCompare;
      return a.optionValue.localeCompare(b.optionValue);
    });

    // Get badge assignments
    const allProductIds = [...new Set(allRows.map((row) => row.productId))];
    const badges = {};

    if (allProductIds.length > 0) {
      const badgeQuery = `
        SELECT * FROM badge_assignments 
        WHERE shop = $1 
        AND product_id = ANY($2)
        AND option_type = $3
      `;
      const result = await pool.query(badgeQuery, [
        shop,
        allProductIds,
        selectedOption,
      ]);

      result.rows.forEach((row) => {
        const key = `${row.product_id}_${row.option_value}`;
        badges[key] = {
          badge_type: row.badge_type,
          option_value: row.option_value,
        };
      });
    }

    // PAGINATE THE ROWS
    const totalRows = allRows.length;
    const totalPages = Math.ceil(totalRows / limit);
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedRows = allRows.slice(startIndex, endIndex);

    // Transform rows to product format for frontend compatibility
    const productsForPage = paginatedRows.map((row) => ({
      id: row.productId,
      title: row.productTitle,
      handle: row.productHandle,
      image: row.productImage,
      options: [
        {
          name: selectedOption,
          values: [row.optionValue],
        },
      ],
      variants: row.variantIds.map((id) => ({
        id: id,
        selectedOptions: [{ name: selectedOption, value: row.optionValue }],
      })),
      // Additional row metadata
      _rowData: {
        optionValue: row.optionValue,
        variantCount: row.variantCount,
      },
    }));

    console.log(
      `✅ Total rows: ${totalRows}, Page ${page}/${totalPages}, Showing: ${paginatedRows.length}`
    );

    res.json({
      products: productsForPage,
      badges,
      selectedOption,
      totalRows: totalRows,
      totalProducts: totalRows, // For frontend compatibility
      currentPage: page,
      totalPages,
      hasMore: page < totalPages,
      limit,
    });
  } catch (error) {
    console.error("Error fetching paginated products:", error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});
// ========== END NEW PAGINATION ENDPOINT ==========

// Get all products with badge assignments (for main UI)
router.get("/all-products", async (req, res) => {
  try {
    const shop = req.shop;
    const { accessToken } = req.shopifySession;

    console.log("📊 Getting all products with badge assignments");

    // Get selected option type from settings
    const { getAppSettings } = require("../database/db");
    const settings = await getAppSettings(shop);
    const selectedOption = settings.selectedOption;
    // Don't show products if "Title" is selected (single-variant products)
    if (selectedOption === "Title") {
      return res.json({
        products: [],
        selectedOption: "Title",
        message: "Title option not supported (single-variant products)",
      });
    }
    if (!selectedOption) {
      return res.json({
        products: [],
        selectedOption: null,
        message: "No option type selected in settings",
      });
    }

    console.log("   Selected option:", selectedOption);

    // Fetch all products from Shopify
    const graphqlUrl = `https://${shop}/admin/api/2024-10/graphql.json`;
    const query = `
      {
        products(first: 50) {
          edges {
            node {
              id
              title
              handle
              featuredImage {
                url
              }
              options {
                name
                values
              }
              variants(first: 100) {
                edges {
                  node {
                    id
                    selectedOptions {
                      name
                      value
                    }
                    image {
                      url
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query }),
    });

    const result = await response.json();

    if (result.errors) {
      console.error("GraphQL errors:", result.errors);
      return res.status(500).json({ error: "GraphQL errors" });
    }

    // Get all badge assignments
    const assignments = await getBadgeAssignments(shop);
    const badgeLookup = {};
    assignments.forEach((a) => {
      badgeLookup[a.variant_id] = a.badge_type;
    });

    // Process each product
    const productsWithOptions = [];

    result.data.products.edges.forEach((edge) => {
      const product = edge.node;
      const productId = product.id.replace("gid://shopify/Product/", "");

      // Check if product has the selected option
      const selectedOptionData = product.options.find(
        (opt) => opt.name === selectedOption
      );

      if (!selectedOptionData) {
        return; // Skip products without this option
      }

      // Group variants by option value
      const optionGroups = {};

      product.variants.edges.forEach((vEdge) => {
        const variant = vEdge.node;
        const variantId = variant.id.replace(
          "gid://shopify/ProductVariant/",
          ""
        );

        const selectedOpt = variant.selectedOptions.find(
          (opt) => opt.name === selectedOption
        );

        if (selectedOpt) {
          const optionValue = selectedOpt.value;

          if (!optionGroups[optionValue]) {
            optionGroups[optionValue] = {
              optionValue,
              variantIds: [],
              imageUrl: variant.image ? variant.image.url : null,
              badges: new Set(),
            };
          }

          optionGroups[optionValue].variantIds.push(variantId);

          // Set image if we don't have one yet
          if (!optionGroups[optionValue].imageUrl && variant.image) {
            optionGroups[optionValue].imageUrl = variant.image.url;
          }

          if (badgeLookup[variantId]) {
            optionGroups[optionValue].badges.add(badgeLookup[variantId]);
          }
        }
      });

      // Convert to array
      const options = Object.values(optionGroups).map((group) => {
        const badge =
          group.badges.size === 1 ? Array.from(group.badges)[0] : "none";

        return {
          optionValue: group.optionValue,
          variantCount: group.variantIds.length,
          variantIds: group.variantIds,
          imageUrl: group.imageUrl,
          badge: badge,
        };
      });

      if (options.length > 0) {
        productsWithOptions.push({
          id: productId,
          title: product.title,
          handle: product.handle,
          imageUrl: product.featuredImage ? product.featuredImage.url : null,
          options: options,
        });
      }
    });

    console.log(
      `✅ Loaded ${productsWithOptions.length} products with ${selectedOption} options`
    );

    res.json({
      products: productsWithOptions,
      selectedOption,
      shop,
    });
  } catch (error) {
    console.error("Error getting all products:", error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// Get all badge assignments for shop
router.get("/", async (req, res) => {
  try {
    const shop = req.shop; // From middleware, not req.query
    const { productId } = req.query;

    // If productId is provided, return grouped option-level data
    if (productId) {
      return getProductBadgesGrouped(req, res);
    }

    // Otherwise return all badges (legacy format)
    const assignments = await getBadgeAssignments(shop);

    // Format: { "variant_id": "badge_type" }
    const badges = {};
    assignments.forEach((row) => {
      badges[row.variant_id] = row.badge_type;
    });

    res.json({ badges });
  } catch (error) {
    console.error("Error fetching badge assignments:", error);
    res.status(500).json({ error: "Failed to fetch badges" });
  }
});

// Helper function to get badges grouped by option value
async function getProductBadgesGrouped(req, res) {
  try {
    const shop = req.shop;
    const { productId } = req.query;
    const { accessToken } = req.shopifySession;

    console.log("📊 Getting grouped badges for product:", productId);

    // Get selected option type from settings
    const { getAppSettings } = require("../database/db");
    const settings = await getAppSettings(shop);
    const selectedOption = settings.selectedOption;

    if (!selectedOption) {
      return res.json({
        options: [],
        message: "No option type selected in settings",
      });
    }

    console.log("   Selected option:", selectedOption);

    // Fetch product with variants from Shopify
    const graphqlUrl = `https://${shop}/admin/api/2024-10/graphql.json`;
    const query = `
      query getProduct($id: ID!) {
        product(id: $id) {
          id
          title
          options {
            name
            values
            position
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query,
        variables: { id: `gid://shopify/Product/${productId}` },
      }),
    });

    const result = await response.json();

    if (result.errors || !result.data.product) {
      return res.status(404).json({ error: "Product not found" });
    }

    const product = result.data.product;

    // Find the selected option (e.g., "Color")
    const selectedOptionData = product.options.find(
      (opt) => opt.name === selectedOption
    );

    if (!selectedOptionData) {
      return res.json({
        options: [],
        message: `Product doesn't have option: ${selectedOption}`,
      });
    }

    // Get badge assignments for this product
    const assignments = await getBadgeAssignments(shop);
    const productAssignments = assignments.filter(
      (a) => a.product_id === productId && a.option_type === selectedOption
    );

    // Create badge lookup: { variantId: badgeType }
    const badgeLookup = {};
    productAssignments.forEach((a) => {
      badgeLookup[a.variant_id] = a.badge_type;
    });

    // Group variants by option value
    const optionGroups = {};

    product.variants.edges.forEach((edge) => {
      const variant = edge.node;
      const variantId = variant.id.replace("gid://shopify/ProductVariant/", "");

      // Find the value for the selected option
      const selectedOpt = variant.selectedOptions.find(
        (opt) => opt.name === selectedOption
      );

      if (selectedOpt) {
        const optionValue = selectedOpt.value;

        if (!optionGroups[optionValue]) {
          optionGroups[optionValue] = {
            optionValue,
            variantIds: [],
            badges: new Set(),
          };
        }

        optionGroups[optionValue].variantIds.push(variantId);

        // Track which badges are assigned to variants in this group
        if (badgeLookup[variantId]) {
          optionGroups[optionValue].badges.add(badgeLookup[variantId]);
        }
      }
    });

    // Convert to array format for frontend
    const options = Object.values(optionGroups).map((group) => {
      // If all variants in group have same badge, show it
      // Otherwise show "none"
      const badge =
        group.badges.size === 1 ? Array.from(group.badges)[0] : "none";

      return {
        optionValue: group.optionValue,
        variantCount: group.variantIds.length,
        variantIds: group.variantIds,
        badge: badge,
      };
    });

    console.log("✅ Grouped badges:", options.length, "option values");

    res.json({
      options,
      selectedOption,
      productTitle: product.title,
    });
  } catch (error) {
    console.error("Error getting grouped badges:", error);
    res.status(500).json({ error: "Failed to fetch badges" });
  }
}

// Save badge assignment for an option value (applies to all matching variants)
router.post("/", checkPlanLimits, async (req, res) => {
  try {
    const shop = req.shop; // From middleware, not req.body
    const { productId, optionValue, badgeType } = req.body;

    if (!productId || !optionValue) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    // === ADD THIS BLOCK HERE ===
    // Check if adding a badge to a NEW product would exceed limits
    if (badgeType && badgeType !== "none") {
      const currentBadges = await getBadgeAssignments(shop);
      const currentProductIds = new Set(currentBadges.map((b) => b.product_id));
      const isNewProduct = !currentProductIds.has(productId);

      // If new product and at limit, block
      if (isNewProduct && !req.planLimits.canAddBadges) {
        return res.status(403).json({
          error: "Product limit reached",
          message: `Free plan allows badges on ${req.planLimits.maxProducts} products. Upgrade to Pro for unlimited products.`,
          currentProducts: req.planLimits.currentProducts,
          maxProducts: req.planLimits.maxProducts,
          plan: req.planLimits.plan,
          needsUpgrade: true,
        });
      }
    }
    // === END OF NEW BLOCK ===
    console.log("💾 Saving badge for shop:", shop);
    console.log(
      "   Product:",
      productId,
      "Option:",
      optionValue,
      "Badge:",
      badgeType
    );

    // Get current selected option type from settings
    const { getAppSettings } = require("../database/db");
    const settings = await getAppSettings(shop);
    const optionType = settings.selectedOption;

    if (!optionType) {
      return res.status(400).json({
        error: "No option type selected in settings",
      });
    }

    // Fetch product variants from Shopify to find all matching variants
    const { accessToken } = req.shopifySession;
    const graphqlUrl = `https://${shop}/admin/api/2024-10/graphql.json`;

    const query = `
      query getProduct($id: ID!) {
        product(id: $id) {
          variants(first: 100) {
            edges {
              node {
                id
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query,
        variables: { id: `gid://shopify/Product/${productId}` },
      }),
    });

    const result = await response.json();

    if (result.errors || !result.data.product) {
      return res.status(404).json({ error: "Product not found" });
    }

    // Find all variants that match the option value
    const matchingVariants = result.data.product.variants.edges
      .filter((edge) => {
        const variant = edge.node;
        const selectedOpt = variant.selectedOptions.find(
          (opt) => opt.name === optionType && opt.value === optionValue
        );
        return !!selectedOpt;
      })
      .map((edge) => edge.node.id.replace("gid://shopify/ProductVariant/", ""));

    console.log(
      `   Found ${matchingVariants.length} variants matching ${optionValue}`
    );

    // Save or delete badge for each matching variant
    if (badgeType && badgeType !== "none") {
      // Save badge to all matching variants
      for (const variantId of matchingVariants) {
        await saveBadgeAssignment(
          shop,
          variantId,
          productId,
          badgeType,
          optionValue,
          optionType
        );
      }
      console.log(
        `✅ Saved ${badgeType} badge to ${matchingVariants.length} variants`
      );
    } else {
      // Delete badge from all matching variants
      for (const variantId of matchingVariants) {
        await deleteBadgeAssignment(shop, variantId);
      }
      console.log(`✅ Removed badges from ${matchingVariants.length} variants`);
    }

    res.json({
      success: true,
      variantsUpdated: matchingVariants.length,
    });
  } catch (error) {
    console.error("Error saving badge:", error);
    res.status(500).json({ error: "Failed to save badge" });
  }
});

// Delete badge assignment
router.delete("/", async (req, res) => {
  try {
    const shop = req.shop; // From middleware, not req.query
    const { variantId } = req.query;

    if (!variantId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    console.log("🗑️ Deleting badge for shop:", shop, "variant:", variantId);

    await deleteBadgeAssignment(shop, variantId);

    console.log("✅ Badge deleted successfully");
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting badge:", error);
    res.status(500).json({ error: "Failed to delete badge" });
  }
});

module.exports = router;

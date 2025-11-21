const express = require("express");
const router = express.Router();

// GraphQL query to fetch products with variants and options
const PRODUCTS_QUERY = `
  query getProducts($first: Int!) {
    products(first: $first) {
      edges {
        node {
          id
          title
          handle
          options {
            id
            name
            values
            position
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                price
                compareAtPrice
                selectedOptions {
                  name
                  value
                }
                image {
                  url
                  altText
                }
              }
            }
          }
          images(first: 10) {
            edges {
              node {
                id
                url
                altText
              }
            }
          }
        }
      }
    }
  }
`;

// GET /api/products - Fetch products using GraphQL
router.get("/products", async (req, res) => {
  try {
    const { shop, accessToken } = req.shopifySession;
    console.log("📦 Fetching products via GraphQL for shop:", shop);

    // Make GraphQL request to Shopify
    const graphqlUrl = `https://${shop}/admin/api/2024-10/graphql.json`;

    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: PRODUCTS_QUERY,
        variables: {
          first: 50, // Fetch first 50 products
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ GraphQL request failed:", response.status, errorText);
      return res.status(response.status).json({
        error: "Failed to fetch products from Shopify",
        details: errorText,
      });
    }
    // ADD THIS CHECK:
    if (response.status === 401) {
      console.log("❌ Shopify returned 401 - access token invalid");
      return res.status(401).json({
        error: "Shop not authenticated",
        needsAuth: true,
        hint: "Access token expired or revoked",
      });
    }
    const result = await response.json();

    if (result.errors) {
      console.error("❌ GraphQL errors:", result.errors);
      return res.status(500).json({
        error: "GraphQL query errors",
        details: result.errors,
      });
    }

    // Transform GraphQL response to match frontend expectations
    const products = result.data.products.edges.map((edge) => {
      const product = edge.node;

      return {
        id: product.id.replace("gid://shopify/Product/", ""),
        title: product.title,
        handle: product.handle,
        options: product.options.map((opt) => ({
          id: opt.id.replace("gid://shopify/ProductOption/", ""),
          name: opt.name,
          values: opt.values,
          position: opt.position,
        })),
        variants: product.variants.edges.map((vEdge, index) => {
          const variant = vEdge.node;

          // Map selectedOptions to option1, option2, option3 format
          const option1 = variant.selectedOptions[0]?.value || null;
          const option2 = variant.selectedOptions[1]?.value || null;
          const option3 = variant.selectedOptions[2]?.value || null;

          return {
            id: variant.id.replace("gid://shopify/ProductVariant/", ""),
            title: variant.title,
            price: variant.price,
            compare_at_price: variant.compareAtPrice,
            option1,
            option2,
            option3,
            image_id: variant.image
              ? variant.image.url.split("/").pop().split("?")[0]
              : null,
          };
        }),
        images: product.images.edges.map((imgEdge) => {
          const image = imgEdge.node;
          return {
            id: image.id.replace("gid://shopify/ProductImage/", ""),
            src: image.url,
            alt: image.altText,
          };
        }),
      };
    });

    console.log("✅ Products fetched successfully:", products.length);

    res.json({
      products,
      count: products.length,
      message: "Products fetched via GraphQL API",
    });
  } catch (error) {
    console.error("❌ Error fetching products:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// GET /api/products/:id - Get a single product (for Phase 2)
router.get("/products/:id", async (req, res) => {
  try {
    const { shop, accessToken } = req.shopifySession;
    const productId = req.params.id;

    console.log("📦 Fetching product:", productId);

    const SINGLE_PRODUCT_QUERY = `
      query getProduct($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          options {
            id
            name
            values
            position
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                price
                compareAtPrice
                selectedOptions {
                  name
                  value
                }
                image {
                  url
                  altText
                }
              }
            }
          }
        }
      }
    `;

    const graphqlUrl = `https://${shop}/admin/api/2024-10/graphql.json`;

    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: SINGLE_PRODUCT_QUERY,
        variables: {
          id: `gid://shopify/Product/${productId}`,
        },
      }),
    });

    const result = await response.json();

    if (result.errors) {
      return res
        .status(500)
        .json({ error: "GraphQL errors", details: result.errors });
    }

    if (!result.data.product) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({ product: result.data.product });
  } catch (error) {
    console.error("❌ Error fetching product:", error);
    res
      .status(500)
      .json({ error: "Internal server error", details: error.message });
  }
});

module.exports = router;

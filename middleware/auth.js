const { getShopSession } = require("../database/db");

// Middleware to validate session token from App Bridge
async function validateSessionToken(shopify) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        console.log("❌ No Authorization header found");
        return res.status(401).json({ error: "Missing authorization header" });
      }

      const sessionToken = authHeader.replace("Bearer ", "");
      console.log("🔐 Validating session token...");
      console.log("   Token length:", sessionToken.length);
      console.log("   Token starts with:", sessionToken.substring(0, 50) + "...");

      // Decode and validate the session token
      let payload;
      try {
        payload = await shopify.session.decodeSessionToken(sessionToken);
        console.log("✅ Session token decoded successfully");
      } catch (decodeError) {
        console.error("❌ Token decode error:", decodeError.message);
        console.error("   Full error:", decodeError);
        return res.status(401).json({
          error: "Invalid session token",
          details: decodeError.message,
        });
      }

      console.log("✅ Session token validated");
      console.log("   Destination:", payload.dest);
      console.log("   Audience:", payload.aud);

      // Get the shop domain from the token
      const shop = payload.dest.replace("https://", "").replace("/admin", "");
      console.log("   Extracted shop:", shop);

      // Get the access token from database
      const session = await getShopSession(shop);

      if (!session) {
        console.log("❌ Shop not authenticated in database:", shop);
        return res.status(401).json({
          error: "Shop not authenticated",
          shop,
          needsAuth: true,
          hint: "Please complete the OAuth installation flow",
        });
      }

      console.log("✅ Shop session found in database");
      console.log("   Access token length:", session.accessToken.length);

      // Attach session to request for use in route handlers
      req.shopifySession = {
        shop: session.shop,
        accessToken: session.accessToken,
      };

      next();
    } catch (error) {
      console.error("❌ Session token validation error:", error.message);
      console.error("   Stack:", error.stack);
      return res.status(500).json({
        error: "Token validation failed",
        details: error.message,
      });
    }
  };
}

module.exports = { validateSessionToken };

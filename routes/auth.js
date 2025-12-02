const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const { getShopSession } = require("../database/db");

router.get("/token", async (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    console.log("🔐 Generating session token for:", shop);

    const session = await getShopSession(shop);
    if (!session || !session.accessToken) {
      console.log("❌ Shop not authenticated:", shop);
      return res.status(401).json({
        error: "Shop not authenticated",
        needsAuth: true,
      });
    }

    const payload = {
      iss: `https://${shop}/admin`,
      dest: `https://${shop}`,
      aud: process.env.SHOPIFY_API_KEY,
      sub: session.id || "shop-session",
      exp: Math.floor(Date.now() / 1000) + 60,
      nbf: Math.floor(Date.now() / 1000),
      iat: Math.floor(Date.now() / 1000),
      jti: require("crypto").randomBytes(16).toString("hex"),
      sid: session.id || "session-id",
    };

    const token = jwt.sign(payload, process.env.SHOPIFY_API_SECRET, {
      algorithm: "HS256",
    });

    console.log("✅ Generated fresh session token");
    res.json({ token, expiresIn: 60 });
  } catch (error) {
    console.error("❌ Error generating token:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

module.exports = router;

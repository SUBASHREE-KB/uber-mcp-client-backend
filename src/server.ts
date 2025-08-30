// src/server.ts
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { MCPClient } from "./mcpClient";
import cors from "cors";

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(cors()); // Enable CORS for React Native app

const port = Number(process.env.PORT || 4000);
const client = new MCPClient();

// Track MCP readiness
let mcpReady = false;

client.on("ready", () => {
  console.log("[SERVER] MCP is ready");
  mcpReady = true;
});

client.on("error", (error) => {
  console.error("[SERVER] MCP error:", error);
});

client.on("exit", (code) => {
  console.error("[SERVER] MCP process exited with code:", code);
  mcpReady = false;
});

async function initMCP() {
  console.log("[SERVER] Initializing MCP client...");
  const mode = (process.env.MCP_MODE || "local").toLowerCase();
  
  if (mode === "remote") {
    const wsUrl = process.env.MCP_REMOTE_WS_URL;
    if (!wsUrl) throw new Error("MCP_REMOTE_WS_URL is required in remote mode");
    await client.connectRemote(wsUrl);
    console.log("[SERVER] Connected to remote MCP at", wsUrl);
  } else {
    const cmd = process.env.MCP_LOCAL_CMD || "npx mcp-uber";
    await client.startLocal(cmd);
    console.log("[SERVER] Started local MCP with command:", cmd);
  }

  // Set up event listeners
  client.on("log", (l) => console.log("[MCP LOG]", l));
  client.on("stderr", (d) => console.log("[MCP STDERR]", d));
  
  // Wait a bit more for MCP to be fully ready
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  if (!mcpReady) {
    console.warn("[SERVER] MCP may not be fully ready, but continuing...");
    mcpReady = true; // Allow requests to proceed
  }
}

// Initialize MCP
initMCP().catch((e) => {
  console.error("Failed to init MCP client:", e);
  process.exit(1);
});

// Middleware to check MCP readiness
const checkMCPReady = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!mcpReady) {
    return res.status(503).json({ 
      error: "MCP not ready yet",
      message: "The MCP client is still initializing. Please try again in a few seconds."
    });
  }
  next();
};

// API Endpoints
app.get("/health", (_req, res) => {
  res.json({ 
    ok: true,
    mcpReady,
    timestamp: new Date().toISOString()
  });
});

// Get available tools
app.get("/tools", async (_req, res) => {
  try {
    if (mcpReady) {
      const toolsResponse = await client.listTools();
      res.json(toolsResponse);
    } else {
      // Fallback to static list
      const tools = [
        "uber_get_auth_url",
        "uber_set_access_token", 
        "uber_get_price_estimates",
        "uber_request_ride",
        "uber_get_ride_status",
        "uber_cancel_ride",
      ];
      res.json({ tools });
    }
  } catch (error) {
    console.error("[SERVER] Error getting tools:", error);
    // Fallback to static list
    const tools = [
      "uber_get_auth_url",
      "uber_set_access_token",
      "uber_get_price_estimates", 
      "uber_request_ride",
      "uber_get_ride_status",
      "uber_cancel_ride",
    ];
    res.json({ tools });
  }
});

// Uber OAuth endpoints
app.get("/uber/auth-url", checkMCPReady, async (req, res) => {
  try {
    // Generate a user ID if not provided
    const userId = req.query.userId as string || `user_${Date.now()}`;
    console.log("[SERVER] Getting auth URL for userId:", userId);
    
    const response = await client.uber_get_auth_url({ userId });
    console.log("[SERVER] Auth URL response:", response);
    res.json(response);
  } catch (err: any) {
    console.error("[SERVER] Error getting auth URL:", err);
    res.status(500).json({ 
      error: err.message || String(err),
      details: "Failed to get Uber authorization URL"
    });
  }
});

app.post("/uber/set-access-token", checkMCPReady, async (req, res) => {
  try {
    console.log("[SERVER] Setting access token");
    const { access_token, refresh_token, expires_at, userId } = req.body;
    
    if (!access_token) {
      return res.status(400).json({ error: "access_token is required" });
    }
    
    const userIdToUse = userId || `user_${Date.now()}`;
    
    const response = await client.uber_set_access_token({ 
      userId: userIdToUse,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: expires_at
    });
    console.log("[SERVER] Set token response:", response);
    res.json(response);
  } catch (err: any) {
    console.error("[SERVER] Error setting access token:", err);
    res.status(500).json({ 
      error: err.message || String(err),
      details: "Failed to set access token"
    });
  }
});

// Uber ride endpoints
app.post("/uber/price-estimates", checkMCPReady, async (req, res) => {
  try {
    console.log("[SERVER] Getting price estimates:", req.body);
    const { 
      start_latitude, 
      start_longitude, 
      end_latitude, 
      end_longitude,
      userId 
    } = req.body;
    
    // Validate required parameters
    if (!start_latitude || !start_longitude || !end_latitude || !end_longitude) {
      return res.status(400).json({ 
        error: "Missing required parameters",
        required: ["start_latitude", "start_longitude", "end_latitude", "end_longitude"]
      });
    }
    
    const userIdToUse = userId || `user_${Date.now()}`;
    
    const response = await client.uber_get_price_estimates({
      userId: userIdToUse,
      startLatitude: Number(start_latitude),
      startLongitude: Number(start_longitude),
      endLatitude: Number(end_latitude),
      endLongitude: Number(end_longitude)
    });
    console.log("[SERVER] Price estimates response:", response);
    res.json(response);
  } catch (err: any) {
    console.error("[SERVER] Error getting price estimates:", err);
    res.status(500).json({ 
      error: err.message || String(err),
      details: "Failed to get price estimates"
    });
  }
});

app.post("/uber/request-ride", checkMCPReady, async (req, res) => {
  try {
    console.log("[SERVER] Requesting ride:", req.body);
    const {
      product_id,
      start_latitude,
      start_longitude, 
      end_latitude,
      end_longitude,
      fare_id,
      userId
    } = req.body;
    
    // Validate required parameters
    if (!product_id || !start_latitude || !start_longitude || !end_latitude || !end_longitude) {
      return res.status(400).json({
        error: "Missing required parameters", 
        required: ["product_id", "start_latitude", "start_longitude", "end_latitude", "end_longitude"]
      });
    }
    
    const userIdToUse = userId || `user_${Date.now()}`;
    
    const response = await client.uber_request_ride({
      userId: userIdToUse,
      productId: product_id,
      startLatitude: Number(start_latitude),
      startLongitude: Number(start_longitude),
      endLatitude: Number(end_latitude),
      endLongitude: Number(end_longitude),
      fareId: fare_id
    });
    console.log("[SERVER] Ride request response:", response);
    res.json(response);
  } catch (err: any) {
    console.error("[SERVER] Error requesting ride:", err);
    res.status(500).json({ 
      error: err.message || String(err),
      details: "Failed to request ride"
    });
  }
});

app.get("/uber/ride-status/:request_id", checkMCPReady, async (req, res) => {
  try {
    const { request_id } = req.params;
    const { userId } = req.query;
    
    console.log("[SERVER] Getting ride status for:", request_id);
    
    const userIdToUse = userId as string || `user_${Date.now()}`;
    
    const response = await client.uber_get_ride_status({ 
      userId: userIdToUse,
      requestId: request_id 
    });
    console.log("[SERVER] Ride status response:", response);
    res.json(response);
  } catch (err: any) {
    console.error("[SERVER] Error getting ride status:", err);
    res.status(500).json({ 
      error: err.message || String(err),
      details: "Failed to get ride status"
    });
  }
});

app.post("/uber/cancel-ride", checkMCPReady, async (req, res) => {
  try {
    console.log("[SERVER] Cancelling ride:", req.body);
    const { request_id, userId } = req.body;
    
    if (!request_id) {
      return res.status(400).json({ error: "request_id is required" });
    }
    
    const userIdToUse = userId || `user_${Date.now()}`;
    
    const response = await client.uber_cancel_ride({ 
      userId: userIdToUse,
      requestId: request_id 
    });
    console.log("[SERVER] Cancel ride response:", response);
    res.json(response);
  } catch (err: any) {
    console.error("[SERVER] Error cancelling ride:", err);
    res.status(500).json({ 
      error: err.message || String(err),
      details: "Failed to cancel ride"
    });
  }
});

// OAuth callback endpoint (for testing)
app.get("/callback", (req, res) => {
  const { code, error } = req.query;
  
  if (error) {
    console.error("[OAuth] Authorization error:", error);
    return res.status(400).json({ error: "Authorization failed", details: error });
  }
  
  if (code) {
    console.log("[OAuth] Authorization code received:", code);
    res.json({ 
      success: true, 
      code,
      message: "Authorization successful. Use this code to exchange for access token."
    });
  } else {
    res.status(400).json({ error: "No authorization code received" });
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SERVER] Received SIGTERM, shutting down gracefully');
  client.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[SERVER] Received SIGINT, shutting down gracefully');
  client.close();
  process.exit(0);
});

app.listen(port, () => {
  console.log(`[SERVER] Backend running on http://localhost:${port}`);
  console.log(`[SERVER] Health check: http://localhost:${port}/health`);
  console.log(`[SERVER] Tools list: http://localhost:${port}/tools`);
});
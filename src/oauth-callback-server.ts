// src/oauth-callback-server.ts
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const port = 4001;

// OAuth callback endpoint
app.get("/callback", async (req, res) => {
  console.log("[OAuth] Callback received with query params:", req.query);
  
  const { code, error, error_description, state } = req.query;
  
  if (error) {
    console.error("[OAuth] Authorization error:", error);
    console.error("[OAuth] Error description:", error_description);
    
    // Send error page
    res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>OAuth Error</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 50px; }
          .error { color: red; }
          .container { max-width: 600px; margin: 0 auto; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Authorization Failed</h1>
          <div class="error">
            <p><strong>Error:</strong> ${error}</p>
            ${error_description ? `<p><strong>Description:</strong> ${error_description}</p>` : ''}
          </div>
          <p>Please try again or contact support if the issue persists.</p>
        </div>
      </body>
      </html>
    `);
    return;
  }
  
  if (code) {
    console.log("[OAuth] Authorization successful!");
    console.log("[OAuth] Authorization code:", code);
    console.log("[OAuth] State:", state);
    
    try {
      // Exchange code for access token
      const tokenResponse = await exchangeCodeForToken(code as string);
      
      if (tokenResponse.access_token) {
        console.log("[OAuth] Access token obtained successfully");
        
        // Store the token (you can modify this to send to your main backend)
        await storeAccessToken(state as string, tokenResponse);
        
        // Send success page
        res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Authorization Successful</title>
            <style>
              body { font-family: Arial, sans-serif; margin: 50px; }
              .success { color: green; }
              .container { max-width: 600px; margin: 0 auto; }
              .token-info { background: #f0f0f0; padding: 15px; margin: 20px 0; }
              .copy-btn { background: #007bff; color: white; padding: 5px 10px; border: none; cursor: pointer; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1 class="success">Authorization Successful!</h1>
              <p>Your Uber account has been successfully linked.</p>
              
              <div class="token-info">
                <h3>Access Token Information:</h3>
                <p><strong>Access Token:</strong> <span id="token">${tokenResponse.access_token}</span> 
                   <button class="copy-btn" onclick="copyToken()">Copy</button></p>
                <p><strong>Token Type:</strong> ${tokenResponse.token_type}</p>
                <p><strong>Expires In:</strong> ${tokenResponse.expires_in} seconds</p>
                ${tokenResponse.scope ? `<p><strong>Scope:</strong> ${tokenResponse.scope}</p>` : ''}
              </div>
              
              <p>You can now close this window and return to your application.</p>
            </div>
            
            <script>
              function copyToken() {
                const token = document.getElementById('token').textContent;
                navigator.clipboard.writeText(token).then(() => {
                  alert('Token copied to clipboard!');
                });
              }
            </script>
          </body>
          </html>
        `);
      } else {
        throw new Error('No access token received');
      }
      
    } catch (error) {
      console.error("[OAuth] Error exchanging code for token:", error);
      res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Token Exchange Error</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 50px; }
            .error { color: red; }
            .container { max-width: 600px; margin: 0 auto; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Token Exchange Failed</h1>
            <div class="error">
              <p>Failed to exchange authorization code for access token.</p>
              <p><strong>Error:</strong> ${error}</p>
            </div>
          </div>
        </body>
        </html>
      `);
    }
  } else {
    res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>OAuth Error</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 50px; }
          .error { color: red; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Authorization Error</h1>
          <div class="error">
            <p>No authorization code received from Uber.</p>
          </div>
        </div>
      </body>
      </html>
    `);
  }
});

// Function to exchange authorization code for access token
async function exchangeCodeForToken(code: string) {
  const clientId = process.env.UBER_CLIENT_ID;
  const clientSecret = process.env.UBER_CLIENT_SECRET;
  const redirectUri = process.env.UBER_REDIRECT_URI;
  
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing Uber OAuth credentials in environment variables");
  }
  
  const tokenEndpoint = process.env.UBER_ENVIRONMENT === 'production' 
    ? 'https://auth.uber.com/oauth/v2/token'
    : 'https://auth.uber.com/oauth/v2/token'; // Same endpoint for sandbox
  
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
    }),
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
  }
  
  return data;
}

// Function to store access token (send to main backend)
async function storeAccessToken(userId: string, tokenData: any) {
  try {
    const mainBackendUrl = `http://localhost:${process.env.PORT || 4000}`;
    
    const response = await fetch(`${mainBackendUrl}/uber/set-access-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: userId || `user_${Date.now()}`,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: tokenData.expires_in ? Date.now() + (tokenData.expires_in * 1000) : null,
      }),
    });
    
    if (response.ok) {
      console.log("[OAuth] Successfully stored access token in main backend");
    } else {
      console.error("[OAuth] Failed to store access token in main backend");
    }
  } catch (error) {
    console.error("[OAuth] Error storing access token:", error);
  }
}

// Health check
app.get("/health", (req, res) => {
  res.json({ 
    ok: true, 
    service: "OAuth Callback Server",
    port: port,
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(port, () => {
  console.log(`[OAuth Server] Running on http://localhost:${port}`);
  console.log(`[OAuth Server] Callback URL: http://localhost:${port}/callback`);
  console.log(`[OAuth Server] Health check: http://localhost:${port}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[OAuth Server] Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[OAuth Server] Received SIGINT, shutting down gracefully');  
  process.exit(0);
});